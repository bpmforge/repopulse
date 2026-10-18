import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  candidateOf,
  loadTriageCases,
  outcomeOf,
  renderTriageEval,
  scoreModel,
  upsertRow,
  type TriageEvalFile,
} from './eval.js';
import { sliceAround } from './slice.js';
import type { TriageProposal } from './types.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs');
const { note, cases } = loadTriageCases();

const proposal = (dedupKey: string, verdict: TriageProposal['verdict']): TriageProposal => ({
  dedupKey,
  verdict,
  confidence: 3,
  model: 'm',
  checklistVersion: 'triage.v1',
  rationale: '',
  citations: [],
  vex: null,
  patch: null,
  route: null,
});

describe('the labelled cases', () => {
  it('are balanced, uniquely named and point at the line they flag', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.filter((c) => c.truth === 'real')).toHaveLength(6);
    expect(cases.filter((c) => c.truth === 'false_positive')).toHaveLength(6);
    for (const c of cases) {
      const line = c.source[c.finding.lineStart - 1] ?? '';
      const quote = c.finding.evidenceQuote.replace(/\s+/g, ' ').trim();
      expect(line.replace(/\s+/g, ' '), c.id).toContain(quote);
    }
  });

  it('every flagged line lands inside the slice the model would be shown', () => {
    for (const c of cases) {
      const cand = candidateOf(c);
      const s = sliceAround(
        cand.source,
        c.finding.file,
        c.finding.lineStart,
        c.finding.lineEnd,
        5000,
      );
      expect(s.startLine, c.id).toBeLessThanOrEqual(c.finding.lineStart);
      expect(s.endLine, c.id).toBeGreaterThanOrEqual(c.finding.lineEnd);
    }
  });

  it('carry a stated reason for their label, and the file admits the labels are unreviewed', () => {
    for (const c of cases) expect(c.why.length, c.id).toBeGreaterThan(20);
    expect(note).toMatch(/NOT independently reviewed/);
  });
});

describe('scoring', () => {
  it('agrees on matching verdicts, disagrees on contradictions, abstains on needs_human', () => {
    expect(outcomeOf('real', 'real')).toBe('agree');
    expect(outcomeOf('false_positive', 'likely_false_positive')).toBe('agree');
    expect(outcomeOf('real', 'likely_false_positive')).toBe('disagree');
    expect(outcomeOf('false_positive', 'real')).toBe('disagree');
    expect(outcomeOf('real', 'needs_human')).toBe('abstained');
    expect(outcomeOf('real', null)).toBe('rejected');
  });

  it('computes agreement over committed verdicts only, and counts missed real on its own', () => {
    const [a, b, c, d, e] = cases;
    const row = scoreModel({
      model: 'm',
      ranAt: '2026-10-18T00:00:00Z',
      checklistVersion: 'triage.v1',
      cases: [a!, b!, c!, d!, e!].map((x, i) => ({
        ...x,
        truth: i === 0 ? 'real' : i === 1 ? 'real' : 'false_positive',
      })),
      proposals: [
        proposal(a!.finding.dedupKey, 'real'), // agree
        proposal(b!.finding.dedupKey, 'likely_false_positive'), // missed real
        proposal(c!.finding.dedupKey, 'needs_human'), // abstained
        // d: no proposal -> rejected
        proposal(e!.finding.dedupKey, 'likely_false_positive'), // agree
      ],
    });
    expect(row).toMatchObject({
      total: 5,
      agree: 2,
      disagree: 1,
      abstained: 1,
      rejected: 1,
      missedReal: 1,
    });
    expect(row.agreement).toBeCloseTo(2 / 3);
  });

  it('agreement is null, not 0%, when a model never committed to a verdict', () => {
    const row = scoreModel({ model: 'm', ranAt: 'x', checklistVersion: 'v', cases, proposals: [] });
    expect(row.agreement).toBeNull();
    expect(row.rejected).toBe(cases.length);
  });

  it("a rerun replaces that model's row and keeps the others", () => {
    const mk = (model: string, agree: number) => ({
      ...scoreModel({ model, ranAt: 'x', checklistVersion: 'v', cases, proposals: [] }),
      agree,
    });
    let f: TriageEvalFile = { schema: 1, rows: [] };
    f = upsertRow(f, mk('b', 1));
    f = upsertRow(f, mk('a', 2));
    f = upsertRow(f, mk('b', 9));
    expect(f.rows.map((r) => [r.model, r.agree])).toEqual([
      ['a', 2],
      ['b', 9],
    ]);
  });
});

describe('the published table', () => {
  it('says it has not been run when no model has been scored', () => {
    const md = renderTriageEval({ schema: 1, rows: [] }, note);
    expect(md).toContain('has not been run yet');
    expect(md).not.toContain('| Model |');
  });

  it('explains the metrics, including that needs_human is not an error', () => {
    const md = renderTriageEval({ schema: 1, rows: [] }, note);
    expect(md).toMatch(/not counted as wrong/);
    expect(md).toMatch(/costly error/);
  });

  it('keeps docs/TRIAGE_EVAL.md equal to its rendering of docs/triage-eval.json', () => {
    const jsonPath = path.join(DOCS, 'triage-eval.json');
    const file: TriageEvalFile = existsSync(jsonPath)
      ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as TriageEvalFile)
      : { schema: 1, rows: [] };
    expect(readFileSync(path.join(DOCS, 'TRIAGE_EVAL.md'), 'utf8')).toBe(
      renderTriageEval(file, note),
    );
  });
});
