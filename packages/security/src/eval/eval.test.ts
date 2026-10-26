import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  SPECIALIST_IDS,
  type AnalysisGateway,
  type CompleteOpts,
  type CompleteResult,
} from '@repopulse/analysis';
import { loadEvalCases } from './fixtures.js';
import { matchFindings } from './match.js';
import { renderModelEval } from './render.js';
import { MODEL_EVAL_RESULTS } from './results.generated.js';
import { evaluateSpecialists } from './run.js';
import { scoreRole } from './score.js';
import type { ModelEvalFile } from './types.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs');
const cases = loadEvalCases();

const f = (file: string, quote: string) => ({
  file,
  evidence_quote: quote,
  line_range: [1, 1] as [number, number],
});

describe('the labelled fixtures', () => {
  it('give every role at least four cases, half with a planted defect and half clean', () => {
    // Four per role; performance has eight since W21-20 added the algorithmic
    // shapes (a join by scan, a linear search over sorted data) and their clean
    // look-alikes. The balance is what keeps precision and recall comparable.
    for (const role of SPECIALIST_IDS) {
      expect(cases[role].length, role).toBeGreaterThanOrEqual(4);
      expect(
        cases[role].filter((c) => c.labels.length > 0),
        role,
      ).toHaveLength(cases[role].length / 2);
    }
    expect(cases.performance).toHaveLength(8);
  });

  it('plant each defect on a quote that really appears in the code shown', () => {
    for (const role of SPECIALIST_IDS) {
      for (const c of cases[role]) {
        const text =
          c.kind === 'diff'
            ? c.files.map((x) => `${x.path}\n${x.patch}`).join('\n')
            : c.kind === 'file'
              ? `${c.path}\n${c.content}`
              : c.files.map((x) => `${x.path}\n${x.content}`).join('\n');
        for (const l of c.labels) {
          expect(text.replace(/\s+/g, ' '), `${role}/${c.id}`).toContain(
            l.quote.replace(/\s+/g, ' '),
          );
          expect(text, `${role}/${c.id}`).toContain(l.file);
        }
      }
    }
  });

  it('have unique ids and a stated note', () => {
    const ids = SPECIALIST_IDS.flatMap((r) => cases[r].map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of SPECIALIST_IDS)
      for (const c of cases[r]) expect(c.note.length).toBeGreaterThan(10);
  });
});

describe('matchFindings', () => {
  const labels = [{ file: 'a.ts', quote: 'exec(cmd)' }];
  it('counts a finding on the planted quote as a true positive', () => {
    expect(matchFindings([f('a.ts', '+  return exec(cmd);')], labels)).toEqual({
      tp: 1,
      fp: 0,
      fn: 0,
      duplicates: 0,
    });
  });
  it('counts a finding elsewhere as a false positive and the missed defect as a miss', () => {
    expect(matchFindings([f('a.ts', 'something else')], labels)).toEqual({
      tp: 0,
      fp: 1,
      fn: 1,
      duplicates: 0,
    });
  });
  it('does not count the right quote on the wrong file', () => {
    expect(matchFindings([f('b.ts', 'exec(cmd)')], labels)).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });
  it('treats a repeat of an already-found defect as a duplicate, not a second true positive or a false one', () => {
    expect(matchFindings([f('a.ts', 'exec(cmd)'), f('a.ts', 'exec(cmd)')], labels)).toEqual({
      tp: 1,
      fp: 0,
      fn: 0,
      duplicates: 1,
    });
  });
  it('scores every finding on a clean case as a false positive', () => {
    expect(matchFindings([f('a.ts', 'x'), f('a.ts', 'y')], [])).toEqual({
      tp: 0,
      fp: 2,
      fn: 0,
      duplicates: 0,
    });
  });
});

describe('scoreRole', () => {
  const t = (o: Partial<Parameters<typeof scoreRole>[0][number]> = {}) => ({
    errored: false,
    formatFailure: false,
    tp: 0,
    fp: 0,
    fn: 0,
    duplicates: 0,
    ...o,
  });
  it('computes precision and recall', () => {
    const s = scoreRole([t({ tp: 2, fp: 1 }), t({ fn: 1 })]);
    expect(s.precision).toBeCloseTo(2 / 3);
    expect(s.recall).toBeCloseTo(2 / 3);
    expect(s.state).toBe('scored');
  });
  it('leaves precision null (not 100%) when nothing was reported, and recall null with no defects', () => {
    expect(scoreRole([t()]).precision).toBeNull();
    expect(scoreRole([t({ fp: 1 })]).recall).toBeNull();
  });
  it('withholds both numbers when any case errored, and counts it', () => {
    const s = scoreRole([t({ tp: 1 }), t({ errored: true })]);
    expect(s).toMatchObject({
      state: 'incomplete',
      errored: 1,
      precision: null,
      recall: null,
      cases: 2,
    });
  });
});

describe('evaluateSpecialists', () => {
  const reply = (text: string): CompleteResult => ({
    text,
    model: 'm',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: null,
    durationMs: 1,
  });
  const finding = (file: string, quote: string) =>
    JSON.stringify({
      findings: [
        {
          dimension: 'x',
          severity: 3,
          confidence: 4,
          file,
          line_range: [1, 1],
          title: 't',
          evidence_quote: quote,
          rationale: 'r',
          suggested_fix: null,
        },
      ],
    });
  const deps = (gateway: AnalysisGateway, roles: readonly (typeof SPECIALIST_IDS)[number][]) => ({
    gateway,
    model: 'm',
    engine: 'test',
    seed: null,
    temperature: 0.1,
    roles,
  });
  const gw = (
    complete: (prompt: string, opts: CompleteOpts) => CompleteResult,
  ): AnalysisGateway => ({
    async complete(prompt, opts) {
      return complete(prompt, opts);
    },
    async health() {
      return { ok: true };
    },
  });

  it('scores a perfect model 100% / 100% on a role', async () => {
    const security = cases.security;
    const gateway = gw((prompt) => {
      const c = security.find((x) => x.labels.some((l) => prompt.includes(l.quote.slice(0, 20))));
      return reply(c ? finding(c.labels[0]!.file, c.labels[0]!.quote) : '{"findings":[]}');
    });
    const r = await evaluateSpecialists(cases, deps(gateway, ['security']));
    expect(r.roles.security).toMatchObject({
      precision: 1,
      recall: 1,
      state: 'scored',
      errored: 0,
    });
    expect(r.complete).toBe(true);
  });

  it('scores a model that finds nothing as 0% recall with precision null', async () => {
    const r = await evaluateSpecialists(
      cases,
      deps(
        gw(() => reply('{"findings":[]}')),
        ['performance'],
      ),
    );
    expect(r.roles.performance).toMatchObject({ recall: 0, precision: null, tp: 0 });
  });

  it('reports a provider error loudly and does NOT score it as "found nothing"', async () => {
    let n = 0;
    const gateway = gw(() => {
      if (++n === 2) throw new ProviderError('Model host responded 503: overloaded');
      return reply('{"findings":[]}');
    });
    const r = await evaluateSpecialists(cases, deps(gateway, ['code_health']));
    expect(r.complete).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ role: 'code_health' });
    expect(r.errors[0]!.error).toMatch(/503/);
    expect(r.roles.code_health).toMatchObject({
      state: 'incomplete',
      errored: 1,
      precision: null,
      recall: null,
    });
  });

  it('counts a model that never answers in the required format, and scores it as nothing found', async () => {
    const r = await evaluateSpecialists(
      cases,
      deps(
        gw(() => reply('I think it is fine.')),
        ['ai_slop'],
      ),
    );
    expect(r.roles.ai_slop?.formatFailures).toBe(4);
    expect(r.roles.ai_slop?.recall).toBe(0);
    expect(r.complete).toBe(true);
  });

  it('forces the specialist to run, so the planner cannot hide a defect from it', async () => {
    let called = 0;
    const gateway = gw(() => {
      called += 1;
      return reply('{"findings":[]}');
    });
    // a docs-style tiny diff would be skipped by the planner; the eval must still ask
    await evaluateSpecialists(
      { ...cases, test_coverage: cases.test_coverage },
      deps(gateway, ['test_coverage']),
    );
    expect(called).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic in what it asks: same cases, same prompts, regardless of concurrency', async () => {
    const seen = (concurrency: number) => {
      const prompts: string[] = [];
      const gateway = gw((p) => {
        prompts.push(p);
        return reply('{"findings":[]}');
      });
      return evaluateSpecialists(cases, { ...deps(gateway, ['security']), concurrency }).then(() =>
        prompts.sort(),
      );
    };
    expect(await seen(1)).toEqual(await seen(4));
  });
});

describe('the published table', () => {
  it('says "not yet run" for everything when nothing was measured', () => {
    const md = renderModelEval({ schema: 1, rows: [] });
    expect(md).toContain('has not been run yet');
    expect(md).toContain('not yet run');
  });

  it('shows not-yet-run for a role a model was not evaluated on, and the engine and date for the run', () => {
    const file: ModelEvalFile = {
      schema: 1,
      rows: [
        {
          model: 'x/y',
          engine: 'OpenAI-compatible endpoint at localhost:1234',
          ranAt: '2026-10-18T00:00:00.000Z',
          temperature: 0.1,
          seed: null,
          checklistVersions: { security: 'v1' },
          complete: true,
          roles: {
            security: {
              cases: 4,
              errored: 0,
              formatFailures: 0,
              tp: 2,
              fp: 0,
              fn: 0,
              duplicates: 0,
              precision: 1,
              recall: 1,
              state: 'scored',
            },
          },
          triage: null,
          errors: [],
        },
      ],
    };
    const md = renderModelEval(file);
    expect(md).toContain('localhost:1234');
    expect(md).toContain('2026-10-18');
    expect(md).toMatch(/\| Security \| v1 \| 4 \| 100% \| 100%/);
    expect(md).toMatch(/\| Performance \| — \| — \| not yet run/);
    expect(md).toContain('Triage agreement: not yet run');
  });

  it('marks an incomplete run and lists its provider errors', () => {
    const file: ModelEvalFile = {
      schema: 1,
      rows: [
        {
          model: 'm',
          engine: 'e',
          ranAt: '2026-10-18T00:00:00.000Z',
          temperature: 0.1,
          seed: 7,
          checklistVersions: {},
          complete: false,
          roles: {
            security: {
              cases: 4,
              errored: 1,
              formatFailures: 0,
              tp: 0,
              fp: 0,
              fn: 0,
              duplicates: 0,
              precision: null,
              recall: null,
              state: 'incomplete',
            },
          },
          triage: null,
          errors: [{ role: 'security', caseId: 'sec-x', error: 'Model host responded 503' }],
        },
      ],
    };
    const md = renderModelEval(file);
    expect(md).toContain('INCOMPLETE');
    expect(md).toContain('security / sec-x: Model host responded 503');
    expect(md).toMatch(/seed 7 \(requested/);
  });

  it('keeps docs/MODEL_EVAL.md equal to its rendering of the committed results', () => {
    expect(readFileSync(path.join(DOCS, 'MODEL_EVAL.md'), 'utf8')).toBe(
      renderModelEval(MODEL_EVAL_RESULTS),
    );
  });
});
