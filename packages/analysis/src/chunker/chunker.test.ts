import { describe, expect, it } from 'vitest';
import {
  chunkDiff,
  estimateTokens,
  isGenerated,
  projectedOutputTokens,
  splitHunks,
  OUTPUT_BUDGET_TOKENS,
  PROMPT_BUDGET_TOKENS,
  type DiffFile,
} from './index.js';
import { buildChunkPrompt, buildReducePrompt, loadChecklist, prContext } from './prompt.js';

// Diff chunker (W6-02, ANALYSIS_TIERS.md §2, FR-ANALYSIS-3).

/** A synthetic patch with `hunks` hunks of `linesPerHunk` changed lines each. */
function makePatch(hunks: number, linesPerHunk: number, seed = 'x'): string {
  const out: string[] = [];
  for (let h = 0; h < hunks; h++) {
    out.push(`@@ -${h * 100},${linesPerHunk} +${h * 100},${linesPerHunk} @@ function f${h}()`);
    for (let l = 0; l < linesPerHunk; l++) {
      out.push(`+  const ${seed}${h}_${l} = compute(${l}); // padding to make this line realistic`);
    }
  }
  return out.join('\n');
}

describe('token estimation', () => {
  it('follows the documented estimator', () => {
    // tok(s) = ceil(bytes/3.4). Pinned because every budget in the chunker is
    // expressed in these units — a change here silently resizes every chunk.
    expect(estimateTokens('a'.repeat(34))).toBe(10);
    expect(estimateTokens('')).toBe(0);
  });

  it('caps projected output at 10k however large the patch', () => {
    // The ceiling that shapes the whole design: a qwen3.6-class model returns
    // ~10k usable tokens, and a bigger prompt yields a TRUNCATED answer that
    // looks complete rather than an error.
    expect(projectedOutputTokens(1_000_000)).toBe(OUTPUT_BUDGET_TOKENS);
    expect(projectedOutputTokens(1000)).toBe(1150);
  });
});

describe('skipping', () => {
  it('records skipped files with a reason instead of dropping them', () => {
    const files: DiffFile[] = [
      { path: 'pnpm-lock.yaml', patch: '@@ -1 +1 @@\n+lots' },
      { path: 'img.png', patch: null, binary: true },
      { path: 'big.ts', patch: '@@ -1 +1 @@\n+x', patchTruncated: true },
      { path: 'empty.ts', patch: '' },
    ];
    const { chunks, skipped } = chunkDiff(files, 'code_health');
    expect(chunks).toEqual([]);
    // Coverage honesty: a reader must be able to tell "we looked and found
    // nothing" from "we never looked at this file".
    expect(skipped).toEqual([
      { path: 'pnpm-lock.yaml', reason: 'generated' },
      { path: 'img.png', reason: 'binary' },
      { path: 'big.ts', reason: 'patch_truncated' },
      { path: 'empty.ts', reason: 'no_patch' },
    ]);
  });

  it('knows the usual generated files', () => {
    expect(isGenerated('a/pnpm-lock.yaml')).toBe(true);
    expect(isGenerated('web/dist/app.js')).toBe(true);
    expect(isGenerated('src/routeTree.gen.ts')).toBe(true);
    expect(isGenerated('src/app.ts')).toBe(false);
  });
});

describe('chunking', () => {
  it('packs small files together', () => {
    const files: DiffFile[] = Array.from({ length: 5 }, (_, i) => ({
      path: `src/f${i}.ts`,
      patch: makePatch(1, 5, `f${i}`),
    }));
    const { chunks } = chunkDiff(files, 'code_health');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.paths).toHaveLength(5);
  });

  it('splits an oversized file at hunk boundaries, never mid-hunk', () => {
    const { chunks } = chunkDiff(
      [{ path: 'src/huge.ts', patch: makePatch(60, 120) }],
      'code_health',
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.part).toBeDefined();
      // Every chunk after the header starts at a hunk marker. A sub-chunk that
      // began mid-hunk would show changed lines with no surrounding context,
      // which reliably produces confident findings about code that is not there.
      const body = chunk.text.split('\n').slice(1);
      expect(body[0]?.startsWith('@@')).toBe(true);
    }
  });

  it('PROPERTY: every hunk appears in exactly one chunk (5000-line diff)', () => {
    // FR-ANALYSIS-3's acceptance property. A lost hunk is a silently unreviewed
    // change; a duplicated one is a finding raised twice from one line.
    const patch = makePatch(50, 100); // 50 hunks × 100 lines ≈ 5000 lines
    const original = splitHunks(patch);
    expect(original.length).toBe(50);

    const { chunks } = chunkDiff([{ path: 'src/big.ts', patch }], 'security');
    const seen = chunks.flatMap((c) => splitHunks(c.text));

    expect(seen).toHaveLength(original.length);
    expect(new Set(seen).size).toBe(original.length);
    for (const hunk of original) expect(seen).toContain(hunk);
  });

  it('keeps every chunk inside both budgets', () => {
    const files: DiffFile[] = [
      { path: 'a.ts', patch: makePatch(40, 100, 'a') },
      { path: 'b.ts', patch: makePatch(3, 10, 'b') },
      { path: 'c.ts', patch: makePatch(2, 5, 'c') },
    ];
    const { chunks } = chunkDiff(files, 'performance');
    for (const chunk of chunks) {
      expect(chunk.promptTokens).toBeLessThanOrEqual(PROMPT_BUDGET_TOKENS);
      expect(chunk.projectedOutputTokens).toBeLessThanOrEqual(OUTPUT_BUDGET_TOKENS);
    }
  });

  it('never emits an empty chunk', () => {
    expect(chunkDiff([], 'code_health').chunks).toEqual([]);
  });
});

describe('prompts', () => {
  it('carries the checklist, the PR context and the chunk', () => {
    const { chunks } = chunkDiff([{ path: 'src/a.ts', patch: makePatch(1, 3) }], 'security');
    const prompt = buildChunkPrompt({
      dimension: 'security',
      chunk: chunks[0]!,
      prTitle: 'Add auth',
      prBody: 'Adds a login route',
    });
    expect(prompt.text).toContain('senior security reviewer');
    expect(prompt.text).toContain('Add auth');
    expect(prompt.text).toContain('src/a.ts');
    expect(prompt.text).toContain('evidence_quote');
    expect(prompt.checklistVersion).toBe('v1');
  });

  it('truncates a huge PR description rather than dropping or sending it whole', () => {
    const body = 'x'.repeat(50_000);
    const context = prContext('T', body);
    expect(context).toContain('[description truncated]');
    // A 50kB description would crowd out the diff it describes.
    expect(estimateTokens(context)).toBeLessThan(1200);
  });

  it('REDUCE receives findings JSON, never the diff again', () => {
    const reduce = buildReducePrompt({
      dimension: 'code_health',
      findings: [{ title: 'x', file: 'a.ts' }],
      prTitle: 'T',
      skipped: [{ path: 'pnpm-lock.yaml', reason: 'generated' }],
    });
    // Bounded regardless of PR size — the summary must never be the call that
    // blows the budget.
    expect(reduce.text).not.toContain('@@');
    expect(reduce.text).toContain('"title":"x"');
    expect(reduce.text).toContain('coverage gap');
    expect(reduce.tokens).toBeLessThan(2000);
  });

  it('loads every dimension checklist as a versioned file', () => {
    for (const dim of ['code_health', 'security', 'performance', 'test_coverage'] as const) {
      const text = loadChecklist(dim);
      expect(text.length).toBeGreaterThan(200);
      // Diff-scoped framing is what keeps findings anchored to the change.
      expect(text.toLowerCase()).toContain('diff');
    }
  });
});
