import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports, decideGate, isClean, type Comparison } from './regression.js';
import type { BenchmarkReport } from './report.js';

// W19-06. The committed report is the ratchet: any measured row that got worse
// fails, a row the new run did not measure is NOT a pass, and one bad run on a
// loaded machine never fails the gate on its own.

const COMMITTED = JSON.parse(
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../docs/benchmarks/report.json',
    ),
    'utf8',
  ),
) as BenchmarkReport;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('compareReports', () => {
  it('finds nothing wrong comparing the committed report with itself', () => {
    const c = compareReports(COMMITTED, clone(COMMITTED));
    expect(c.regressions).toEqual([]);
    expect(c.coverageLost).toEqual([]);
    expect(c.compared).toBeGreaterThan(50);
    expect(isClean(c)).toBe(true);
  });

  it('flags a lost true positive in the totals and in the rule that lost it', () => {
    const cur = clone(COMMITTED);
    cur.totals.tp -= 1;
    cur.totals.fn += 1;
    const rule = cur.byRule.find((r) => r.score.tp > 0)!;
    rule.score.tp -= 1;
    rule.score.fn += 1;
    const c = compareReports(COMMITTED, cur);
    expect(c.regressions.map((r) => `${r.scope}:${r.metric}`)).toEqual(
      expect.arrayContaining(['totals:tp', 'totals:fn', 'rule:tp', 'rule:fn']),
    );
    expect(c.regressions.find((r) => r.scope === 'rule')!.key).toBe(rule.rule);
  });

  it('flags a new false positive even when the totals improve elsewhere', () => {
    const cur = clone(COMMITTED);
    const suites = cur.bySuite.filter((s) => s.score.tp > 0);
    suites[0]!.score.fp += 1;
    suites[1]!.score.tp += 5; // an improvement must not mask it
    const c = compareReports(COMMITTED, cur);
    expect(
      c.regressions.some(
        (r) => r.scope === 'suite' && r.key === suites[0]!.suite && r.metric === 'fp',
      ),
    ).toBe(true);
    expect(c.improved).toBeGreaterThan(0);
  });

  it('does not call an improvement a regression, but counts it', () => {
    const cur = clone(COMMITTED);
    cur.totals.tp += 3;
    cur.totals.fn -= 3;
    const c = compareReports(COMMITTED, cur);
    expect(c.regressions).toEqual([]);
    expect(c.improved).toBe(2);
  });

  it('treats an engine that did not run as lost coverage, not a pass', () => {
    const cur = clone(COMMITTED);
    cur.engines.yaml = { status: 'unavailable', reason: 'opengrep not found' };
    const c = compareReports(COMMITTED, cur);
    expect(c.coverageLost[0]).toMatch(/YAML engine did not run \(opengrep not found\)/);
    expect(isClean(c)).toBe(false);
  });

  it('treats a rule that vanished from the new run as lost coverage', () => {
    const cur = clone(COMMITTED);
    const gone = cur.byRule.findIndex((r) => r.score.tp + r.score.fp + r.score.fn > 0);
    const name = cur.byRule[gone]!.rule;
    cur.byRule.splice(gone, 1);
    expect(compareReports(COMMITTED, cur).coverageLost).toContain(
      `rule "${name}" is absent from the new run`,
    );
  });

  it('ignores a rule that scored nothing before — there is nothing to regress from', () => {
    const cur = clone(COMMITTED);
    const empty = cur.byRule.find((r) => r.score.tp + r.score.fp + r.score.fn === 0)!;
    empty.score.fp = 4;
    expect(compareReports(COMMITTED, cur).regressions.filter((r) => r.key === empty.rule)).toEqual(
      [],
    );
  });

  it('flags a CWE whose detection rate fell or whose false-alarm rate rose', () => {
    const cur = clone(COMMITTED);
    const cwe = cur.byCwe.find((c) => c.tpr !== null && c.tpr > 0)!;
    cwe.tpr = Math.max(0, cwe.tpr! - 0.1);
    const c = compareReports(COMMITTED, cur);
    expect(c.regressions.some((r) => r.scope === 'cwe' && r.metric === 'tpr')).toBe(true);
  });
});

describe('a suite that is no longer prepared', () => {
  it('is reported as the one cause, without a wall of derived regressions', () => {
    const cur = clone(COMMITTED);
    const suite = cur.corpus.find((c) => c.id === 'owasp-benchmark')!;
    suite.status = 'not-prepared';
    cur.totals.tp = 10; // everything downstream collapses too
    cur.bySuite.find((s) => s.suite === 'owasp-benchmark')!.score.tp = 0;
    const c = compareReports(COMMITTED, cur);
    expect(c.regressions).toEqual([]);
    expect(c.coverageLost).toHaveLength(1);
    expect(c.coverageLost[0]).toMatch(/"owasp-benchmark" is not prepared.*bench:prepare/);
    expect(isClean(c)).toBe(false);
  });
});

describe('decideGate — one bad run on a loaded machine never fails alone', () => {
  const bad = (key = 'a'): Comparison => ({
    regressions: [{ scope: 'rule', key, metric: 'tp', before: 2, after: 1 }],
    coverageLost: [],
    improved: 0,
    compared: 10,
  });
  const ok: Comparison = { regressions: [], coverageLost: [], improved: 0, compared: 10 };
  const sequence = (...cs: Comparison[]) => {
    let i = 0;
    return async () => cs[Math.min(i++, cs.length - 1)]!;
  };

  it('passes after a single clean run, without running a second', async () => {
    let runs = 0;
    const r = await decideGate(async () => (runs++, ok));
    expect(r).toEqual({ status: 'pass', flagged: false });
    expect(runs).toBe(1);
  });

  it('passes FLAGGED when the first run regressed and the second did not, and says why', async () => {
    const r = await decideGate(sequence(bad(), ok), () => 'load average 9.1 on 8 cores');
    expect(r).toMatchObject({ status: 'pass', flagged: true });
    expect(r.status === 'pass' && r.flagged && r.note).toMatch(
      /treated as load, not the rules.*load average 9\.1/,
    );
  });

  it('FAILS, confirmed, when the same rows regress on both runs', async () => {
    const r = await decideGate(sequence(bad(), bad()));
    expect(r).toMatchObject({ status: 'fail', kind: 'confirmed' });
  });

  it('FAILS as unstable when two runs disagree and neither is clean', async () => {
    const r = await decideGate(sequence(bad('a'), bad('b')));
    expect(r).toMatchObject({ status: 'fail', kind: 'unstable' });
  });

  it('a coverage loss that repeats also fails — measuring less is not a way to pass', async () => {
    const lost: Comparison = { ...ok, coverageLost: ['the YAML engine did not run (x)'] };
    expect(await decideGate(sequence(lost, lost))).toMatchObject({
      status: 'fail',
      kind: 'confirmed',
    });
  });
});
