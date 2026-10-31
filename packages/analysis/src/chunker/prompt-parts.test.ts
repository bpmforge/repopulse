import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chunkDiff } from './index.js';
import { buildChunkPrompt, buildPromptParts } from './prompt.js';
import { PROMPT_PART_SEPARATOR, usablePromptParts } from '../gateway/types.js';

// W23-06. The static block (checklist + schema + rules) must be byte-identical
// across every chunk of a dimension, or the provider's prefix cache never hits.

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function patch(seed: string): string {
  return [
    '@@ -1,3 +1,5 @@ function f()',
    ` const a = ${seed};`,
    `+const ${seed}_x = compute(${seed});`,
    `+const ${seed}_y = compute(${seed}_x);`,
  ].join('\n');
}

const chunks = ['a', 'b', 'c'].map((s) => ({
  text: patch(s),
  paths: [`src/${s}.ts`],
  tokens: 40,
}));

describe('static/dynamic prompt split (W23-06)', () => {
  it.each(['security', 'performance', 'code_health'] as const)(
    'static block hashes identically across 3 chunks (%s)',
    (dimension) => {
      const parts = chunks.map((chunk) =>
        buildPromptParts({ dimension, chunk: chunk as never, prTitle: 'Title', prBody: 'Body' }),
      );
      const hashes = parts.map((p) => sha(p.static));
      expect(new Set(hashes).size).toBe(1);
      // ...while the dynamic part really does differ per chunk.
      expect(new Set(parts.map((p) => sha(p.dynamic))).size).toBe(3);
    },
  );

  it('static does not change with the PR, only with dimension and version', () => {
    const a = buildPromptParts({
      dimension: 'security',
      chunk: chunks[0] as never,
      prTitle: 'A',
      prBody: null,
    });
    const b = buildPromptParts({
      dimension: 'security',
      chunk: chunks[1] as never,
      prTitle: 'B',
      prBody: 'long body',
    });
    expect(a.static).toBe(b.static);
    const perf = buildPromptParts({
      dimension: 'performance',
      chunk: chunks[0] as never,
      prTitle: 'A',
      prBody: null,
    });
    expect(perf.static).not.toBe(a.static);
  });

  it('keeps checklist + schema in static and PR context + diff in dynamic', () => {
    const p = buildPromptParts({
      dimension: 'security',
      chunk: chunks[0] as never,
      prTitle: 'Add auth',
      prBody: null,
    });
    expect(p.static).toContain('senior security reviewer');
    expect(p.static).toContain('"findings"');
    expect(p.static).toContain('evidence_quote');
    expect(p.static).not.toContain('Add auth');
    expect(p.static).not.toContain('@@');
    expect(p.dynamic).toContain('Add auth');
    expect(p.dynamic).toContain('src/a.ts');
    expect(p.dynamic).toContain('```diff');
    expect(p.dynamic).toContain(chunks[0]!.text);
  });

  it('the single prompt is exactly static + blank line + dynamic', () => {
    const built = buildChunkPrompt({
      dimension: 'security',
      chunk: chunks[0] as never,
      prTitle: 'T',
      prBody: null,
    });
    expect(built.parts).toBeDefined();
    expect(built.text).toBe(
      `${built.parts!.static}${PROMPT_PART_SEPARATOR}${built.parts!.dynamic}`,
    );
  });

  it('works on real chunker output (every chunk of a multi-file diff shares one static block)', () => {
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `src/f${i}.ts`,
      patch: Array.from({ length: 30 }, (_, h) => patch(`f${i}h${h}`)).join('\n'),
    }));
    const { chunks: real } = chunkDiff(files, 'security', {
      promptTokens: 1500,
      outputTokens: 10_000,
    });
    expect(real.length).toBeGreaterThanOrEqual(3);
    const statics = new Set(
      real.map((c) =>
        sha(
          buildPromptParts({ dimension: 'security', chunk: c, prTitle: 'T', prBody: null }).static,
        ),
      ),
    );
    expect(statics.size).toBe(1);
  });

  it('usablePromptParts refuses parts that do not reassemble to the prompt', () => {
    const parts = { static: 'S', dynamic: 'D' };
    expect(usablePromptParts('S\n\nD', parts)).toBe(parts);
    expect(usablePromptParts('S\n\nD + retry', parts)).toBeNull();
    expect(usablePromptParts('S\n\nD', undefined)).toBeNull();
    expect(usablePromptParts('\n\nD', { static: '', dynamic: 'D' })).toBeNull();
  });
});
