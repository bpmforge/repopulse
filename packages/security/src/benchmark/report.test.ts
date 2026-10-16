import { describe, expect, it } from 'vitest';
import { matchFindings, type BenchFinding, type Label } from './match.js';
import { buildReport, renderMarkdown, type EngineSummary } from './report.js';

const engines: EngineSummary = {
  fastLane: { rules: 1 },
  yaml: { status: 'unavailable', reason: 'test' },
};

const f = (file: string, ruleId: string, line = 1): BenchFinding => ({
  suite: 'demo',
  tree: 'app',
  file,
  lineStart: line,
  lineEnd: line,
  ruleId,
  dimension: ruleId.startsWith('slop.') ? 'slop' : 'secrets',
  cwe: null,
});

const labels: Label[] = [
  {
    suite: 'demo',
    tree: 'app',
    id: 'hit',
    file: 'a.ts',
    lines: [1, 1],
    rule: 'slop.a',
    dimension: 'slop',
    expect: 'finding',
  },
  {
    suite: 'demo',
    tree: 'app',
    id: 'miss',
    file: 'b.ts',
    rule: 'slop.a',
    dimension: 'slop',
    expect: 'finding',
  },
];

function report(findings: BenchFinding[]) {
  const outcomes = matchFindings({
    findings,
    labels,
    rulesRun: new Set(['slop.a', 'jwt']),
    dimensionsRun: new Set(['slop', 'secrets']),
    policy: () => 'fp',
  });
  return buildReport({
    engines,
    corpus: [
      {
        id: 'demo',
        title: 'Demo',
        source: { kind: 'authored', licence: 'ours' },
        status: 'scored',
        trees: 1,
        labels: 2,
      },
    ],
    rules: [
      { rule: 'slop.a', engine: 'fast-lane', dimension: 'slop' },
      { rule: 'jwt', engine: 'fast-lane', dimension: 'secrets' },
    ],
    outcomes,
  });
}

describe('benchmark report', () => {
  it('scores per rule, per dimension and per suite', () => {
    const r = report([f('a.ts', 'slop.a'), f('c.ts', 'jwt', 4)]);
    expect(r.totals).toMatchObject({ tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
    expect(r.byRule.map((x) => [x.rule, x.score.tp, x.score.fp, x.score.fn])).toEqual([
      ['jwt', 0, 1, 0],
      ['slop.a', 1, 0, 1],
    ]);
    expect(r.byDimension.map((x) => x.dimension)).toEqual(['secrets', 'slop']);
    expect(r.bySuite).toEqual([{ suite: 'demo', score: r.totals }]);
  });

  it('lists a rule that ran even when the corpus never touches it', () => {
    const r = report([]);
    expect(r.byRule.find((x) => x.rule === 'jwt')?.score).toMatchObject({ tp: 0, fp: 0, fn: 0 });
  });

  it('serialises byte-identically for the same input in any order — the diffability contract', () => {
    const a = [f('a.ts', 'slop.a'), f('c.ts', 'jwt', 4), f('d.ts', 'jwt', 2)];
    const one = report(a);
    const two = report([...a].reverse());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(renderMarkdown(two)).toBe(renderMarkdown(one));
  });

  it('carries no timestamps or absolute paths', () => {
    const json = JSON.stringify(report([f('a.ts', 'slop.a')]));
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(json).not.toContain(process.cwd());
  });

  it('renders the misses, false positives and a skipped YAML engine in the markdown', () => {
    const md = renderMarkdown(report([f('c.ts', 'jwt', 4)]));
    expect(md).toContain('YAML packs: not run (test)');
    expect(md).toContain('## Missed (false negatives) (2)');
    expect(md).toContain('- `demo/app/c.ts:4` jwt');
    expect(md).toContain('| 0 | 1 | 2 | 0 | 0.0% | 0.0%');
  });
});

describe('per-CWE accuracy on the public suites (W18-40)', () => {
  const pub = (id: string, expect: 'finding' | 'none', cwe: number): Label => ({
    suite: 'pub',
    tree: 't',
    id,
    file: `${id}.java`,
    cwe,
    dimension: 'sast',
    expect,
  });
  const hit = (id: string, cwe: number): BenchFinding => ({
    suite: 'pub',
    tree: 't',
    file: `${id}.java`,
    lineStart: 1,
    lineEnd: 1,
    ruleId: 'bpm-x',
    dimension: 'sast',
    cwe,
  });

  const outcomes = matchFindings({
    findings: [hit('a1', 89), hit('a2', 89), hit('s2', 89), hit('b1', 78)],
    labels: [
      pub('a1', 'finding', 89),
      pub('a2', 'finding', 89),
      pub('a3', 'finding', 89),
      pub('s1', 'none', 89),
      pub('s2', 'none', 89),
      pub('b1', 'finding', 78),
      pub('b2', 'finding', 78),
      pub('c1', 'finding', 22),
    ],
    rulesRun: new Set(['bpm-x']),
    dimensionsRun: new Set(['sast']),
    policy: () => 'ignore',
  });
  const built = buildReport({
    engines,
    corpus: [
      {
        id: 'pub',
        title: 'Public',
        source: { kind: 'fetched', licence: 'x' },
        status: 'scored',
        trees: 1,
        labels: 8,
      },
      {
        id: 'demo',
        title: 'Demo',
        source: { kind: 'authored', licence: 'x' },
        status: 'scored',
        trees: 1,
        labels: 0,
      },
    ],
    rules: [{ rule: 'bpm-x', engine: 'yaml', dimension: 'sast' }],
    outcomes,
    measured: { date: '2026-10-16', commit: 'abc' },
  });

  it('scores TPR, FPR and Youden per CWE, in OWASP Benchmark units', () => {
    const c89 = built.byCwe.find((c) => c.cwe === 89)!;
    expect(c89).toMatchObject({ tp: 2, fn: 1, fp: 1, tn: 1, tpr: 0.667, fpr: 0.5, youden: 0.167 });
  });

  it('keeps a CWE with no hits in the table at 0% rather than leaving it out', () => {
    expect(built.byCwe.find((c) => c.cwe === 22)).toMatchObject({ tp: 0, fn: 1, tpr: 0 });
  });

  it('reports a rate as null when its denominator is empty', () => {
    const c78 = built.byCwe.find((c) => c.cwe === 78)!;
    expect(c78.fpr).toBeNull();
    expect(c78.youden).toBeNull();
  });

  it('covers fetched suites only and sorts by suite then CWE', () => {
    expect(built.byCwe.map((c) => c.suite)).toEqual(['pub', 'pub', 'pub']);
    expect(built.byCwe.map((c) => c.cwe)).toEqual([22, 78, 89]);
  });

  it('prints the table with the date and what a score means', () => {
    const md = renderMarkdown(built);
    expect(md).toContain('## Public benchmarks, by CWE');
    expect(md).toContain('Measured 2026-10-16 at abc');
    expect(md).toContain('Youden');
    expect(md).toContain('pub | 89 | 2 | 1 | 1 | 1 | 66.7% | 50.0% | 0.167');
  });

  it('records no date unless asked to, so an unchanged run is byte-identical', () => {
    expect(report([]).measured).toEqual({ date: null, commit: null });
  });
});
