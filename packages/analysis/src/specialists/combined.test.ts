import { describe, expect, it } from 'vitest';
import { budgetForContext } from '../chunker/index.js';
import type { AnalysisGateway, CompleteOpts, CompleteResult } from '../gateway/types.js';
import { ModelNoAnswerError, ModelTimeoutError } from '../t2/client.js';
import {
  buildCombinedPrompt,
  combinedBudget,
  combinedChecklists,
  splitByDimension,
} from './combined.js';
import { fileAreas } from './planner.js';
import { SPECIALISTS, specialistById } from './registry.js';
import { runSpecialists } from './run.js';
import type { ReviewInput } from './units.js';

// W27-05: the first look sends each chunk once with every planned checklist.

const meta = { repoId: '1', prNumber: 0, initiator: 'test' };

const SOURCE = [
  'export async function list(db, id) {',
  '  for (const u of await db.users()) {',
  '    await db.query("select * from t where id=" + id);',
  '  }',
  '}',
].join('\n');

const one: ReviewInput = {
  kind: 'module',
  name: 'm',
  files: [{ path: 'src/users.ts', content: SOURCE }],
};

function scripted(answer: (opts: CompleteOpts, prompt: string, n: number) => string | Error) {
  const calls: { opts: CompleteOpts; prompt: string }[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt, opts): Promise<CompleteResult> {
      calls.push({ opts, prompt });
      const a = answer(opts, prompt, calls.length);
      if (a instanceof Error) throw a;
      return {
        text: a,
        model: 'm-27b',
        tokensIn: 100,
        tokensOut: 10,
        route: null,
      } as unknown as CompleteResult;
    },
    health: async () => ({ ok: true }) as never,
  } as AnalysisGateway;
  return { gateway, calls };
}

const finding = (
  dimension: string,
  quote = 'await db.query("select * from t where id=" + id);',
) => ({
  dimension,
  severity: 4,
  confidence: 4,
  file: 'src/users.ts',
  line_range: [3, 3],
  title: `${dimension} problem`,
  evidence_quote: quote,
  rationale: 'because',
  suggested_fix: null,
});

describe('the combined prompt', () => {
  it('puts the code first and every checklist, then the answer format, after it', () => {
    const planned = [specialistById('security'), specialistById('code_health')];
    const { text } = buildCombinedPrompt({
      specialists: planned,
      chunk: { paths: ['a.ts'], text: '--- a.ts\n+x', promptTokens: 3, projectedOutputTokens: 800 },
      title: 'First look',
    });
    const diff = text.indexOf('```diff');
    const sec = text.indexOf('## Checklist: security');
    const health = text.indexOf('## Checklist: code_health');
    const json = text.indexOf('Respond ONLY with JSON');
    expect(diff).toBeGreaterThan(-1);
    expect(diff).toBeLessThan(sec);
    expect(sec).toBeLessThan(health);
    expect(health).toBeLessThan(json);
    expect(text).toContain('"dimension":"security" | "code_health"');
  });

  it('shrinks the chunk budget by what the extra checklists cost', () => {
    const base = budgetForContext(32_768);
    const all = combinedBudget(base, SPECIALISTS);
    expect(all.promptTokens).toBeLessThan(base.promptTokens);
    expect(all.outputTokens).toBe(base.outputTokens);
    expect(combinedChecklists(SPECIALISTS).split('## Checklist:')).toHaveLength(7);
  });
});

describe('splitByDimension', () => {
  it('normalises spelling and aliases, and drops (never relabels) a checklist not asked', () => {
    const r = splitByDimension(
      {
        findings: [
          finding('Code health'),
          finding('slop'),
          finding('security'),
          finding('licensing'),
          finding(''),
        ],
      },
      ['code_health', 'ai_slop', 'security'],
    );
    const kept = (r.raw as { findings: { dimension: string }[] }).findings.map((f) => f.dimension);
    expect(kept).toEqual(['code_health', 'ai_slop', 'security']);
    expect(r.dropped).toEqual(['licensing', '(none)']);
  });
});

describe('runSpecialists({ combined: true })', () => {
  it('makes one call per chunk and files each finding under its checklist', async () => {
    const { gateway, calls } = scripted(() =>
      JSON.stringify({
        findings: [finding('security'), finding('performance'), finding('made_up')],
      }),
    );
    const r = await runSpecialists(one, { gateway, prTitle: 'First look', meta, combined: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.meta.role).toBe('security');
    expect(calls[0]!.opts.reasoning).toBeUndefined();
    expect(r.combinedLead).toBe('security');
    expect(r.findings.map((f) => [f.specialist, f.checklistVersion])).toEqual([
      ['security', 'v1'],
      ['performance', 'v3'],
    ]);
    expect(r.rejected).toEqual([
      { specialist: 'security', reason: 'dimension "made_up" is not one of the checklists asked' },
    ]);
    // The lead carries the call and tokens; the others their findings.
    expect(r.usage.security).toMatchObject({ calls: 1, tokensIn: 100, findings: 1, rejected: 1 });
    expect(r.usage.performance).toMatchObject({ calls: 0, tokensIn: 0, findings: 1 });
    expect(r.calls).toBe(1);
    expect(r.leftForBudget).toEqual([]);
  });

  it('names the files of chunks past the call budget, best-ranked kept', async () => {
    const big = 'x'.repeat(60_000);
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path) => ({
      path,
      content: `export const v = "${big}";`,
    }));
    const { gateway, calls } = scripted(() => '{"findings":[]}');
    const r = await runSpecialists(
      { kind: 'module', name: 'm', files },
      { gateway, prTitle: 'First look', meta, combined: true, maxCalls: 1 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain('src/a.ts');
    expect(r.leftForBudget).toEqual(['src/b.ts', 'src/c.ts']);
  });

  it('retries a malformed answer once, then a reasoning-only answer once', async () => {
    const malformed = scripted((_o, _p, n) =>
      n === 1 ? 'not json' : JSON.stringify({ findings: [finding('security')] }),
    );
    const a = await runSpecialists(one, {
      gateway: malformed.gateway,
      prTitle: 'First look',
      meta,
      combined: true,
    });
    expect(malformed.calls).toHaveLength(2);
    expect(malformed.calls[1]!.prompt).toMatch(/previous answer was rejected/);
    expect(a.findings).toHaveLength(1);
    expect(a.failures).toEqual([]);

    const silent = scripted((_o, _p, n) =>
      n === 1 ? new ModelNoAnswerError('no answer') : '{"findings":[]}',
    );
    const b = await runSpecialists(one, {
      gateway: silent.gateway,
      prTitle: 'First look',
      meta,
      combined: true,
    });
    expect(silent.calls).toHaveLength(2);
    expect(silent.calls[1]!.prompt).toMatch(/reasoning but no answer/);
    expect(b.failures).toEqual([]);
  });

  it('fails the run when no call answered at all', async () => {
    const { gateway } = scripted(() => new ModelTimeoutError('timed out'));
    await expect(
      runSpecialists(one, { gateway, prTitle: 'First look', meta, combined: true }),
    ).rejects.toBeInstanceOf(ModelTimeoutError);
  });
});

// W27-07: each AI area reads only its own kind of code.
describe('focused areas (W27-07)', () => {
  it('fileAreas: config is security only; perf needs a loop or query; docs go nowhere', () => {
    expect([...fileAreas('deploy/app.yaml', 'ports: [22]')]).toEqual(['security']);
    expect(fileAreas('src/users.ts', SOURCE).has('performance')).toBe(true);
    const math = 'export const add = (a: number, b: number) => a + b;';
    expect(fileAreas('src/math.ts', math).has('performance')).toBe(false);
    expect(fileAreas('src/math.ts', math).has('security')).toBe(false);
    expect(fileAreas('src/math.ts', math).has('code_health')).toBe(true);
    expect(fileAreas('README.md', '# hi').size).toBe(0);
  });

  const mixed: ReviewInput = {
    kind: 'module',
    name: 'm',
    files: [
      { path: 'src/users.ts', content: SOURCE },
      { path: 'src/math.ts', content: 'export const add = (a: number, b: number) => a + b;' },
      { path: 'deploy/app.yaml', content: 'ports:\n  - 22\n' },
      { path: 'README.md', content: '# hello\n' },
    ],
  };

  it('a roster run sends each specialist only its own files', async () => {
    const { gateway, calls } = scripted(() => '{"findings":[]}');
    const r = await runSpecialists(mixed, { gateway, prTitle: 't', meta });
    const sent = (role: string) =>
      calls.filter((c) => c.opts.meta.role === role).map((c) => c.prompt);
    const perf = sent('performance').join('\n');
    expect(perf).toContain('src/users.ts');
    expect(perf).not.toContain('src/math.ts');
    expect(perf).not.toContain('deploy/app.yaml');
    const health = sent('code_health').join('\n');
    expect(health).toContain('src/math.ts');
    expect(health).not.toContain('deploy/app.yaml');
    const sec = sent('security').join('\n');
    expect(sec).toContain('deploy/app.yaml');
    expect(sec).not.toContain('src/math.ts');
    expect(r.skippedFiles.get('performance')).toEqual(
      expect.arrayContaining([
        { path: 'src/math.ts', reason: 'other_area' },
        { path: 'deploy/app.yaml', reason: 'other_area' },
      ]),
    );
  });

  it('a combined run scopes each checklist to its files and refuses out-of-area findings', async () => {
    const { gateway, calls } = scripted(() =>
      JSON.stringify({
        findings: [
          finding('performance'),
          {
            ...finding('performance', 'export const add = (a: number, b: number) => a + b;'),
            file: 'src/math.ts',
            line_range: [1, 1],
          },
        ],
      }),
    );
    const r = await runSpecialists(mixed, { gateway, prTitle: 't', meta, combined: true });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    expect(prompt).not.toContain('README.md');
    expect(prompt).toContain('- performance: only src/users.ts');
    expect(prompt).toContain('- security: only src/users.ts, deploy/app.yaml');
    expect(prompt).toMatch(/- code_health: only src\/users\.ts, src\/math\.ts/);
    expect(r.findings.map((f) => f.file)).toEqual(['src/users.ts']);
    expect(r.rejected).toEqual([
      { specialist: 'security', reason: 'checklist "performance" does not cover src/math.ts' },
    ]);
    expect(r.skippedFiles.get('security')).toContainEqual({
      path: 'README.md',
      reason: 'other_area',
    });
  });
});

describe('focused files in a combined run (W27-08)', () => {
  const none = {
    performance: [],
    code_health: [],
    test_coverage: [],
    best_practices: [],
    ai_slop: [],
  } as const;

  it('sends the union of what the areas read, and drops a file no area reads', async () => {
    const { gateway, calls } = scripted(() => '{"findings":[]}');
    const r = await runSpecialists(
      {
        kind: 'module',
        name: 'm',
        files: [
          { path: 'src/users.ts', content: SOURCE, focus: { ...none, security: [[3, 3]] } },
          { path: 'src/math.ts', content: 'export const add = (a, b) => a + b;\n', focus: none },
        ],
      },
      { gateway, prTitle: 't', meta, combined: true },
    );
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('@@ -0,0 +3,1 @@');
    expect(prompt).not.toContain('export async function list');
    expect(prompt).not.toContain('src/math.ts');
    expect(prompt).toContain('## Checklist: security');
    expect(prompt).not.toContain('## Checklist: code_health');
    expect(r.skippedFiles.get('security')).toContainEqual({
      path: 'src/math.ts',
      reason: 'other_area',
    });
  });
});
