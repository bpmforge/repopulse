import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { budgetForContext, chunkDiff, splitHunks } from '../chunker/index.js';
import { buildChunkPrompt } from '../chunker/prompt.js';
import type { AnalysisGateway, CompleteOpts, CompleteResult } from '../gateway/types.js';
import { ModelNoAnswerError, ModelTimeoutError, ProviderError } from '../t2/client.js';
import { classifyPath, planWaves } from './planner.js';
import { SPECIALISTS, specialistById, type SpecialistId } from './registry.js';
import { extractJson, runSpecialists } from './run.js';
import { contentAsPatch, toDiffFiles, type ReviewInput } from './units.js';

// W19-03. Golden fixtures per specialist: each is a small input with ONE planted
// defect. The checks are deterministic — what the planner picks, how the input is
// chunked at several context windows, what the prompt carries, and that a
// well-formed model answer is accepted while one quoting code that is not there
// is rejected. (Whether a real model FINDS the defect is the W19-05 eval; this
// pins everything around the model.)

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/specialists');

interface Fixture {
  specialist: SpecialistId | null;
  kind: 'diff' | 'file' | 'module';
  files?: { path: string; patch?: string; content?: string }[];
  path?: string;
  content?: string;
  name?: string;
  planted: { quote: string; file: string; title: string } | null;
}

const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map(
    (f) =>
      [f.replace('.json', ''), JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture] as const,
  );

function inputOf(fx: Fixture): ReviewInput {
  if (fx.kind === 'file') return { kind: 'file', path: fx.path!, content: fx.content! };
  if (fx.kind === 'module') {
    return {
      kind: 'module',
      name: fx.name!,
      files: fx.files!.map((f) => ({ path: f.path, content: f.content! })),
    };
  }
  return { kind: 'diff', files: fx.files!.map((f) => ({ path: f.path, patch: f.patch! })) };
}

const meta = { repoId: '1', prNumber: 1, initiator: 'test' };

/** A scripted model: answers every call with the findings it is told to. */
function scripted(answer: (opts: CompleteOpts, prompt: string) => string) {
  const calls: { opts: CompleteOpts; prompt: string }[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt, opts): Promise<CompleteResult> {
      calls.push({ opts, prompt });
      return {
        text: answer(opts, prompt),
        model: 'scripted',
        tokensIn: 1,
        tokensOut: 1,
        costUsd: null,
        durationMs: 1,
      };
    },
    async health() {
      return { ok: true };
    },
  };
  return { gateway, calls };
}

const findingFor = (fx: Fixture, specialist: SpecialistId, quote = fx.planted!.quote) =>
  JSON.stringify({
    findings: [
      {
        dimension: 'security', // deliberately wrong: the specialist's own dimension must win
        severity: 3,
        confidence: 4,
        file: fx.planted!.file,
        line_range: [1, 2],
        title: fx.planted!.title,
        evidence_quote: quote,
        rationale: `planted for ${specialist}`,
        suggested_fix: null,
      },
    ],
  });

describe('the roster', () => {
  it('has the four existing specialists plus best_practices and ai_slop, one role and dimension each', () => {
    expect(SPECIALISTS.map((s) => s.id)).toEqual([
      'security',
      'performance',
      'code_health',
      'test_coverage',
      'best_practices',
      'ai_slop',
    ]);
    for (const s of SPECIALISTS) {
      expect(s.role).toBe(s.id);
      expect(s.dimension).toBe(s.id);
    }
  });

  it('every specialist has a loadable versioned checklist asset', () => {
    for (const s of SPECIALISTS) {
      const prompt = buildChunkPrompt({
        dimension: s.dimension,
        chunk: { paths: ['a.ts'], text: '+x', promptTokens: 1, projectedOutputTokens: 1 },
        prTitle: 't',
        prBody: null,
        version: s.checklistVersion,
      });
      expect(prompt.text).toMatch(/checklist \(v\d\)/);
      expect(prompt.text).toContain('Respond ONLY with JSON');
    }
  });
});

describe.each(fixtures.filter(([, fx]) => fx.specialist !== null))(
  'golden fixture: %s',
  (_name, fx) => {
    const id = fx.specialist as SpecialistId;

    it('is planned for its specialist', () => {
      const files = toDiffFiles(inputOf(fx)).map((f) => ({ path: f.path, text: f.patch }));
      const plan = planWaves(files);
      expect(plan.waves.flatMap((w) => w.specialists.map((s) => s.specialist.id))).toContain(id);
    });

    it.each([8192, 32_768, 262_144, null])(
      'is chunked inside the budget of a %s-token context window, covering every added line',
      (window) => {
        const budget = budgetForContext(window);
        const { chunks, skipped } = chunkDiff(toDiffFiles(inputOf(fx)), id, budget);
        expect(skipped).toEqual([]);
        expect(chunks.length).toBeGreaterThan(0);
        for (const c of chunks) {
          expect(c.promptTokens).toBeLessThanOrEqual(budget.promptTokens);
          expect(c.projectedOutputTokens).toBeLessThanOrEqual(Math.max(budget.outputTokens, 800));
        }
        // The planted code is in exactly one chunk.
        const holding = chunks.filter((c) => c.text.includes(fx.planted!.quote));
        expect(holding).toHaveLength(1);
      },
    );

    it('accepts a well-formed answer, attributing it to the specialist, and routes by its role', async () => {
      const { gateway, calls } = scripted(() => findingFor(fx, id));
      const run = await runSpecialists(inputOf(fx), {
        gateway,
        prTitle: 'fixture',
        meta,
        only: [id],
      });
      expect(run.findings).toHaveLength(1);
      expect(run.findings[0]).toMatchObject({
        specialist: id,
        dimension: id,
        checklistVersion: specialistById(id).checklistVersion,
        title: fx.planted!.title,
      });
      expect(calls[0]?.opts.meta.role).toBe(id);
      // The pass record needs to know what each specialist cost and found (W19-09).
      expect(run.usage[id]).toMatchObject({
        calls: 1,
        tokensIn: 1,
        tokensOut: 1,
        models: ['scripted'],
        findings: 1,
        rejected: 0,
      });
      expect(run.findings[0]).toMatchObject({ model: 'scripted', route: null });
      expect(calls[0]?.opts.meta.dimension).toBe(id);
      expect(run.failures).toEqual([]);
    });

    it('rejects a finding whose quote is not in the code it was shown', async () => {
      const { gateway } = scripted(() => findingFor(fx, id, 'this text is nowhere in the input'));
      const run = await runSpecialists(inputOf(fx), { gateway, prTitle: 'f', meta, only: [id] });
      expect(run.findings).toEqual([]);
      expect(run.rejected).toHaveLength(1);
    });
  },
);

describe('the conditional-wave planner', () => {
  it('runs nothing for a docs-only change and says why for every specialist', () => {
    const plan = planWaves([
      { path: 'README.md', text: '+x' },
      { path: 'docs/a.md', text: '+y' },
    ]);
    expect(plan.waves).toEqual([]);
    expect(plan.skipped).toHaveLength(SPECIALISTS.length);
    expect(plan.skipped[0]?.reason).toMatch(/only docs files changed/);
  });

  it('skips performance when the changed source has no loops, queries or async calls', () => {
    const plan = planWaves([{ path: 'src/a.ts', text: '+export const NAME = "x";' }]);
    const ran = plan.waves.flatMap((w) => w.specialists.map((s) => s.specialist.id));
    expect(ran).not.toContain('performance');
    expect(plan.skipped.find((s) => s.id === 'performance')?.reason).toMatch(/no loops/);
    expect(ran).toContain('code_health');
  });

  it('runs security on configuration alone, and not on test-only changes', () => {
    const cfg = planWaves([{ path: 'infra/main.tf', text: '+cidr = "0.0.0.0/0"' }]);
    expect(cfg.waves.flatMap((w) => w.specialists.map((s) => s.specialist.id))).toEqual([
      'security',
    ]);
    const tests = planWaves([{ path: 'src/a.test.ts', text: '+it("x")' }]);
    expect(tests.skipped.find((s) => s.id === 'security')?.reason).toMatch(/only test files/);
  });

  it('orders waves so security is first and the advisory specialists last', () => {
    const plan = planWaves([{ path: 'src/a.ts', text: '+for (const x of y) { await fetch(x); }' }]);
    expect(plan.waves.map((w) => w.wave)).toEqual([1, 2, 3]);
    expect(plan.waves[0]?.specialists[0]?.specialist.id).toBe('security');
    expect(plan.waves.at(-1)?.specialists.map((s) => s.specialist.id)).toEqual([
      'best_practices',
      'ai_slop',
    ]);
  });

  it('classifies paths', () => {
    expect(classifyPath('src/a.ts')).toBe('source');
    expect(classifyPath('src/a.test.ts')).toBe('test');
    expect(classifyPath('pnpm-lock.yaml')).toBe('generated');
    expect(classifyPath('Dockerfile')).toBe('config');
    expect(classifyPath('docs/x.md')).toBe('docs');
  });
});

describe('repo-wide mode', () => {
  it('presents a file as numbered add-only windows, every line in exactly one window', () => {
    const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const patch = contentAsPatch(content, 120);
    const hunks = splitHunks(patch);
    expect(hunks).toHaveLength(3);
    expect(hunks[0]).toMatch(/^@@ -0,0 \+1,120 @@/);
    expect(hunks[2]).toMatch(/^@@ -0,0 \+241,60 @@/);
    const lines = hunks.flatMap((h) => h.split('\n').slice(1));
    expect(lines).toHaveLength(300);
    expect(lines[299]).toBe('+line 300');
  });

  it('bounds a large file to a small context window and still reviews all of it', () => {
    const content = Array.from({ length: 2000 }, (_, i) => `const value${i} = compute(${i});`).join(
      '\n',
    );
    const budget = budgetForContext(8192);
    const { chunks } = chunkDiff(
      toDiffFiles({ kind: 'file', path: 'big.ts', content }),
      'code_health',
      budget,
    );
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.promptTokens).toBeLessThanOrEqual(budget.promptTokens);
    const covered = chunks.map((c) => c.text).join('\n');
    expect(covered).toContain('const value0 =');
    expect(covered).toContain('const value1999 =');
  });

  it('splits a single oversized hunk rather than emit a chunk over budget', () => {
    const body = Array.from(
      { length: 1500 },
      (_, i) => `+const longer${i} = compute(${i}) + other(${i});`,
    ).join('\n');
    const patch = `@@ -1,0 +1,1500 @@\n${body}`;
    const budget = budgetForContext(8192);
    const { chunks } = chunkDiff([{ path: 'a.ts', patch }], 'code_health', budget);
    for (const c of chunks) expect(c.promptTokens).toBeLessThanOrEqual(budget.promptTokens);
    expect(chunks.length).toBeGreaterThan(3);
  });

  it('derives smaller budgets from smaller probed windows and keeps the defaults when unknown', () => {
    expect(budgetForContext(null)).toEqual({ promptTokens: 24_000, outputTokens: 10_000 });
    expect(budgetForContext(262_144)).toEqual({ promptTokens: 24_000, outputTokens: 10_000 });
    const small = budgetForContext(8192);
    expect(small.promptTokens + small.outputTokens + 3000).toBeLessThanOrEqual(8192);
  });
});

describe('dimension handling (found against a real model)', () => {
  it('names the exact dimension in the required-JSON template', () => {
    const prompt = buildChunkPrompt({
      dimension: 'ai_slop',
      chunk: { paths: ['a.ts'], text: '+x', promptTokens: 1, projectedOutputTokens: 1 },
      prTitle: 't',
      prBody: null,
      version: 'v1',
    });
    expect(prompt.text).toContain('"dimension":"ai_slop"');
    expect(prompt.text).not.toContain('<dimension>');
  });

  it('accepts a correct finding whose model-written dimension label is wrong', async () => {
    const fx = fixtures.find(([n]) => n === 'ai_slop')![1];
    const { gateway } = scripted(() =>
      JSON.stringify({
        findings: [
          {
            dimension: 'slop',
            severity: 4,
            confidence: 5,
            file: fx.planted!.file,
            line_range: [4, 6],
            title: fx.planted!.title,
            evidence_quote: fx.planted!.quote,
            rationale: 'r',
            suggested_fix: null,
          },
        ],
      }),
    );
    const run = await runSpecialists(inputOf(fx), {
      gateway,
      prTitle: 't',
      meta,
      only: ['ai_slop'],
    });
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]?.dimension).toBe('ai_slop');
    expect(run.calls).toBe(1);
  });
});

describe('the runner', () => {
  const inputWithAllSignals: ReviewInput = {
    kind: 'diff',
    files: [
      {
        path: 'src/a.ts',
        patch:
          '@@ -1 +1,3 @@\n+for (const x of y) { await fetch(x); }\n+export const A = 1;\n+export const B = 2;',
      },
    ],
  };

  it('drops later waves first when the call budget is short, and says which', async () => {
    const { gateway, calls } = scripted(() => '{"findings":[]}');
    const run = await runSpecialists(inputWithAllSignals, {
      gateway,
      prTitle: 't',
      meta,
      maxCalls: 3,
    });
    expect(calls).toHaveLength(3);
    // security (wave 1) + performance + code_health ran...
    expect(run.droppedForBudget.length).toBeGreaterThan(0);
    // ...and what was dropped is the advisory end of the roster, never wave 1.
    expect(run.droppedForBudget).not.toContain('security');
    expect(run.droppedForBudget).toContain('ai_slop');
  });

  it('retries once with the error appended, then records a failure instead of salvaging', async () => {
    const { gateway, calls } = scripted(() => 'not json at all');
    const run = await runSpecialists(inputWithAllSignals, {
      gateway,
      prTitle: 't',
      meta,
      only: ['security'],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toMatch(/previous answer was rejected/);
    expect(run.findings).toEqual([]);
    expect(run.failures).toHaveLength(1);
  });

  it('recovers when the retry parses', async () => {
    let n = 0;
    const { gateway } = scripted(() => (n++ === 0 ? 'oops' : '{"findings":[]}'));
    const run = await runSpecialists(inputWithAllSignals, {
      gateway,
      prTitle: 't',
      meta,
      only: ['security'],
    });
    expect(run.failures).toEqual([]);
    expect(run.calls).toBe(2);
  });

  it('keeps finished reviews when a later call times out, and records the timeout (W22-03)', async () => {
    let n = 0;
    const { gateway, calls } = scripted(() => {
      if (n++ === 0) return '{"findings":[]}';
      throw new ModelTimeoutError('the model did not finish within 1200s');
    });
    const run = await runSpecialists(inputWithAllSignals, { gateway, prTitle: 't', meta });
    // Every specialist was still asked; the timed-out ones are not retried.
    expect(calls.length).toBe(Object.keys(run.usage).length);
    expect(run.usage['security']?.calls).toBe(1);
    expect(run.failures.length).toBe(calls.length - 1);
    expect(run.failures[0]?.error).toMatch(/did not finish within 1200s/);
    expect(run.calls).toBe(calls.length);
  });

  it('a provider error on one call is a failure of that call, not of the run', async () => {
    let n = 0;
    const { gateway } = scripted(() => {
      if (n++ === 0) throw new ProviderError('Model host responded 500: model crashed');
      return '{"findings":[]}';
    });
    const run = await runSpecialists(inputWithAllSignals, { gateway, prTitle: 't', meta });
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]?.error).toMatch(/model crashed/);
  });

  it('W25-18: a reasoning-only reply is retried once, then recorded against that chunk only', async () => {
    let n = 0;
    const { gateway, calls } = scripted(() => {
      // The first specialist's two tries both reason without answering.
      if (n++ < 2) throw new ModelNoAnswerError('Model returned no answer: reasoning only');
      return '{"findings":[]}';
    });
    const run = await runSpecialists(inputWithAllSignals, { gateway, prTitle: 't', meta });
    expect(calls[1]?.prompt).toMatch(/reasoning but no answer/);
    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]?.error).toMatch(/no answer/);
    // Every other specialist still ran.
    expect(calls.length).toBe(Object.keys(run.usage).length + 1);
  });

  it('W25-18: recovers when the retry after a reasoning-only reply answers', async () => {
    let n = 0;
    const { gateway } = scripted(() => {
      if (n++ === 0) throw new ModelNoAnswerError('Model returned no answer: reasoning only');
      return '{"findings":[]}';
    });
    const run = await runSpecialists(inputWithAllSignals, {
      gateway,
      prTitle: 't',
      meta,
      only: ['security'],
    });
    expect(run.failures).toEqual([]);
    expect(run.calls).toBe(2);
  });

  it('still throws when no call answered at all, so a dead host fails the pass', async () => {
    const { gateway } = scripted(() => {
      throw new ProviderError('connect ECONNREFUSED');
    });
    await expect(
      runSpecialists(inputWithAllSignals, { gateway, prTitle: 't', meta }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('a refusal that is not a call failure still stops the run at once', async () => {
    const { gateway, calls } = scripted(() => {
      throw new Error('local-only: this role has no local connection');
    });
    await expect(
      runSpecialists(inputWithAllSignals, { gateway, prTitle: 't', meta }),
    ).rejects.toThrow(/local-only/);
    expect(calls).toHaveLength(1);
  });

  it('runs nothing and calls no model for a docs-only change', async () => {
    const complete = vi.fn();
    const run = await runSpecialists(
      { kind: 'diff', files: [{ path: 'README.md', patch: '@@ -1 +1,2 @@\n+x' }] },
      {
        gateway: { complete, health: async () => ({ ok: true }) } as unknown as AnalysisGateway,
        prTitle: 't',
        meta,
      },
    );
    expect(complete).not.toHaveBeenCalled();
    expect(run.plan.waves).toEqual([]);
  });

  it('extractJson handles fences and surrounding prose', () => {
    expect(extractJson('```json\n{"findings":[]}\n```')).toEqual({ findings: [] });
    expect(extractJson('Here you go: {"findings":[]} hope that helps')).toEqual({ findings: [] });
    expect(() => extractJson('nothing')).toThrow(SyntaxError);
  });
});
