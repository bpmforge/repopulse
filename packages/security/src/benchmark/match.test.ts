import { describe, expect, it } from 'vitest';
import { matchFindings, score, type BenchFinding, type Label, type MatchInput } from './match.js';

// The matcher decides every number the benchmark publishes, so each rule of
// the one-finding-one-label contract has a case here.

const finding = (over: Partial<BenchFinding> = {}): BenchFinding => ({
  suite: 's',
  tree: 't',
  file: 'a.js',
  lineStart: 10,
  lineEnd: 10,
  ruleId: 'bpm-x',
  dimension: 'sast',
  cwe: null,
  ...over,
});

// Overrides may set an optional field to undefined to remove it.
type LabelOver = { [K in keyof Label]?: Label[K] | undefined };

const label = (over: LabelOver = {}): Label => {
  const merged: Record<string, unknown> = {
    suite: 's',
    tree: 't',
    id: 'L1',
    file: 'a.js',
    lines: [9, 11],
    rule: 'bpm-x',
    dimension: 'sast',
    expect: 'finding',
    ...over,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as unknown as Label;
};

const run = (findings: BenchFinding[], labels: Label[], over: Partial<MatchInput> = {}) =>
  matchFindings({
    findings,
    labels,
    rulesRun: new Set(['bpm-x', 'bpm-y']),
    dimensionsRun: new Set(['sast', 'slop']),
    policy: () => 'fp',
    ...over,
  });

const kinds = (o: ReturnType<typeof run>) => o.map((x) => `${x.kind}:${x.labelId ?? '-'}`);

describe('matchFindings', () => {
  it('scores an overlapping finding of the labelled rule as a true positive', () => {
    expect(kinds(run([finding()], [label()]))).toEqual(['tp:L1']);
  });

  it('counts a label nothing satisfied as a false negative', () => {
    expect(kinds(run([], [label()]))).toEqual(['fn:L1']);
  });

  it('does not let a finding outside the line range satisfy the label', () => {
    expect(kinds(run([finding({ lineStart: 12, lineEnd: 14 })], [label()]))).toEqual([
      'fn:L1',
      'fp:-',
    ]);
  });

  it('accepts a multi-line finding that straddles the range', () => {
    expect(kinds(run([finding({ lineStart: 5, lineEnd: 9 })], [label()]))).toEqual(['tp:L1']);
  });

  it('does not let a different rule satisfy a rule label, but accepts listed variants', () => {
    expect(kinds(run([finding({ ruleId: 'bpm-y' })], [label()]))).toEqual(['fn:L1', 'fp:-']);
    expect(kinds(run([finding({ ruleId: 'bpm-y' })], [label({ accept: ['bpm-y'] })]))).toEqual([
      'tp:L1',
    ]);
  });

  it('scores a second finding on an already-satisfied label as a duplicate, not a TP or FP', () => {
    const out = run([finding(), finding({ lineStart: 11, lineEnd: 11 })], [label()]);
    expect(kinds(out)).toEqual(['tp:L1', 'duplicate:L1']);
    expect(score(out)).toMatchObject({ tp: 1, fp: 0, duplicate: 1, precision: 1, recall: 1 });
  });

  it('lets two findings satisfy two labels on the same line one-to-one', () => {
    const out = run(
      [finding(), finding({ ruleId: 'bpm-y' })],
      [label({ id: 'A' }), label({ id: 'B', rule: 'bpm-y' })],
    );
    expect(kinds(out)).toEqual(['tp:A', 'tp:B']);
  });

  it('matches a file-level label to any line of that file', () => {
    expect(
      kinds(run([finding({ lineStart: 1, lineEnd: 1 })], [label({ lines: undefined })])),
    ).toEqual(['tp:L1']);
  });

  it('matches a rule-less label by dimension, and a CWE label by CWE only', () => {
    const dim = label({ rule: undefined, dimension: 'sast' });
    expect(kinds(run([finding({ ruleId: 'anything' })], [dim]))).toEqual(['tp:L1']);
    const cwe = label({ rule: undefined, cwe: 89, lines: undefined });
    expect(kinds(run([finding({ cwe: 78 })], [cwe]))).toEqual(['fn:L1', 'fp:-']);
    expect(kinds(run([finding({ cwe: 89 })], [cwe]))).toEqual(['tp:L1']);
  });

  it('prefers the rule label over a rule-less one when a finding could take either', () => {
    const out = run(
      [finding()],
      [label({ id: 'A-dim', rule: undefined }), label({ id: 'B-rule' })],
    );
    expect(kinds(out)).toEqual(['fn:A-dim', 'tp:B-rule']);
  });

  it('counts a finding on a near-miss label as a false positive and an untouched one as a true negative', () => {
    const neg = label({ expect: 'none' });
    expect(kinds(run([finding()], [neg]))).toEqual(['fp:L1']);
    expect(kinds(run([], [neg]))).toEqual(['tn:L1']);
  });

  it('ignores unlabelled findings in a suite whose policy says so', () => {
    const out = run([finding({ file: 'b.js' })], [], { policy: () => 'ignore' });
    expect(kinds(out)).toEqual(['ignored:-']);
    expect(score(out)).toMatchObject({ fp: 0, ignored: 1, precision: null });
  });

  it('skips, rather than misses, a label whose rule did not run', () => {
    const out = run([], [label({ rule: 'bpm-z' })]);
    expect(kinds(out)).toEqual(['skipped:L1']);
    expect(score(out)).toMatchObject({ fn: 0, skipped: 1, recall: null });
  });

  it('skips a rule-less label in a dimension no engine reports', () => {
    expect(kinds(run([], [label({ rule: undefined, dimension: 'dependency' })]))).toEqual([
      'skipped:L1',
    ]);
  });

  it('skips a parse-dependent rule label on a file the engine could not parse', () => {
    const unparsed = { files: new Set(['s/t/a.js']), rules: new Set(['bpm-x']) };
    expect(kinds(run([], [label()], { unparsed }))).toEqual(['skipped:L1']);
    // A rule-less label there still counts: another engine could have read it.
    expect(kinds(run([], [label({ rule: undefined })], { unparsed }))).toEqual(['fn:L1']);
  });

  it('gives the same outcomes whatever order the findings arrive in', () => {
    const fs = [
      finding({ file: 'b.js' }),
      finding(),
      finding({ lineStart: 11, lineEnd: 11 }),
      finding({ ruleId: 'bpm-y', file: 'c.js' }),
    ];
    const labels = [label({ id: 'L2', file: 'b.js' }), label()];
    expect(run([...fs].reverse(), [...labels].reverse())).toEqual(run(fs, labels));
  });
});

describe('score', () => {
  it('reports precision and recall as null when their denominator is zero, never as 1', () => {
    expect(score([])).toMatchObject({ precision: null, recall: null });
  });

  it('rounds to three places', () => {
    const out = run([finding(), finding({ file: 'x.js' }), finding({ file: 'y.js' })], [label()]);
    expect(score(out)).toMatchObject({ tp: 1, fp: 2, precision: 0.333, recall: 1 });
  });
});
