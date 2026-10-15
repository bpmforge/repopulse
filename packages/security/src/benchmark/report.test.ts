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
