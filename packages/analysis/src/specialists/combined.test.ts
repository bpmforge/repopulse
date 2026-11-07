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
