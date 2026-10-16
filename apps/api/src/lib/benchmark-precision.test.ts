import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BENCHMARK_PRECISION } from './benchmark-precision.data.js';
import { summariseBenchmark, type BenchmarkReportInput } from './rule-precision.js';

// The bundled benchmark copy must match the committed report (W18-22).
//
// The API reads a copy so that no request ever depends on docs/ being present
// in the image or on the benchmark being runnable. The price of a copy is that
// it can go stale; this test is what stops that. To refresh after a new
// benchmark run:  UPDATE_BENCHMARK_BUNDLE=1 npx vitest run apps/api/src/lib/benchmark-precision.test.ts

const REPORT = new URL('../../../../docs/benchmarks/report.json', import.meta.url);
const BUNDLE = new URL('./benchmark-precision.data.ts', import.meta.url);

function render(summary: ReturnType<typeof summariseBenchmark>): string {
  return [
    '// GENERATED from docs/benchmarks/report.json by benchmark-precision.test.ts',
    '// (UPDATE_BENCHMARK_BUNDLE=1). Do not edit by hand: the drift test compares',
    '// this file with the committed report and fails when they disagree.',
    "import type { BenchmarkSummary } from './rule-precision.js';",
    '',
    `export const BENCHMARK_PRECISION: BenchmarkSummary = ${JSON.stringify(summary, null, 2)};`,
    '',
  ].join('\n');
}

describe('bundled benchmark precision (W18-22)', () => {
  const report = JSON.parse(readFileSync(REPORT, 'utf8')) as BenchmarkReportInput;
  const fresh = summariseBenchmark(report);

  if (process.env.UPDATE_BENCHMARK_BUNDLE === '1') writeFileSync(BUNDLE, render(fresh));

  it('matches docs/benchmarks/report.json', () => {
    expect(BENCHMARK_PRECISION).toEqual(fresh);
  });

  it('leaves the rule-fixtures suite out of every rule', () => {
    for (const score of Object.values(BENCHMARK_PRECISION.rules)) {
      expect(score.suites).not.toContain('rule-fixtures');
    }
  });

  it('gives no precision to a rule that raised nothing on the corpus', () => {
    const missedOnly = Object.values(BENCHMARK_PRECISION.rules).filter((s) => s.tp + s.fp === 0);
    expect(missedOnly.length).toBeGreaterThan(0);
    for (const score of missedOnly) expect(score.precision).toBeNull();
  });
});

describe('summariseBenchmark', () => {
  it('counts tp/fp/fn per rule, ignores tn/skipped/duplicate and unattributed outcomes', () => {
    const summary = summariseBenchmark({
      ticket: 'T',
      engines: { yaml: { status: 'ran', tool: 'semgrep', version: '1.0.0' } },
      outcomes: [
        { suite: 'a', ruleId: 'r1', kind: 'tp' },
        { suite: 'b', ruleId: 'r1', kind: 'fp' },
        { suite: 'a', ruleId: 'r1', kind: 'tn' },
        { suite: 'a', ruleId: 'r1', kind: 'skipped' },
        { suite: 'a', ruleId: null, kind: 'fn' },
        { suite: 'rule-fixtures', ruleId: 'r1', kind: 'tp' },
        { suite: 'a', ruleId: 'r2', kind: 'fn' },
      ],
      byRule: [{ rule: 'r1', engine: 'yaml' }],
    });
    expect(summary.engine).toBe('semgrep 1.0.0');
    expect(summary.rules.r1).toEqual({
      tp: 1,
      fp: 1,
      fn: 0,
      precision: 0.5,
      suites: ['a', 'b'],
      engine: 'yaml',
    });
    expect(summary.rules.r2).toEqual({
      tp: 0,
      fp: 0,
      fn: 1,
      precision: null,
      suites: ['a'],
      engine: null,
    });
  });

  it('names no engine when the YAML engine did not run', () => {
    expect(
      summariseBenchmark({ ticket: 'T', engines: { yaml: { status: 'skipped' } }, outcomes: [] })
        .engine,
    ).toBeNull();
  });
});

describe('summariseBenchmark: public suites (W18-40)', () => {
  const base = {
    ticket: 'T',
    engines: { yaml: { status: 'ran', tool: 'semgrep', version: '1.0.0' } },
    outcomes: [],
  };

  it('carries per-CWE scores, scored public suites and the measurement date through', () => {
    const cwe = {
      suite: 'owasp-benchmark',
      cwe: 89,
      tp: 3,
      fp: 1,
      fn: 1,
      tn: 3,
      tpr: 0.75,
      fpr: 0.25,
      youden: 0.5,
    };
    const summary = summariseBenchmark({
      ...base,
      byCwe: [cwe],
      corpus: [
        { id: 'owasp-benchmark', title: 'OWASP Benchmark', status: 'scored' },
        { id: 'juliet-java', title: 'Juliet', status: 'not-prepared' },
        { id: 'sampleco', title: 'SampleCo', status: 'scored' },
      ],
      measured: { date: '2026-10-16', commit: 'abc' },
    });
    expect(summary.cwes).toEqual([cwe]);
    expect(summary.publicSuites).toEqual([{ id: 'owasp-benchmark', title: 'OWASP Benchmark' }]);
    expect(summary.measured).toEqual({ date: '2026-10-16', commit: 'abc' });
  });

  it('is empty, not invented, for a report that predates public suites', () => {
    const summary = summariseBenchmark(base);
    expect(summary.cwes).toEqual([]);
    expect(summary.publicSuites).toEqual([]);
    expect(summary.measured).toEqual({ date: null, commit: null });
  });
});
