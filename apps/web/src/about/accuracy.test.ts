import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_ACCURACY, percent } from './accuracy.js';

// W20-23 (UX_TODO X-11). The About page's numbers are a checked-in copy of the
// committed benchmark report. A copy drifts, so every number is checked
// against its source here: a re-run of the benchmark that is committed without
// updating release-accuracy.json fails this test rather than leaving the page
// publishing the old numbers under the new release.

/** The repo root (plan.json sits only there); see findings-link.test.ts. */
function repoRoot(): string {
  let dir = resolve(process.cwd());
  while (!existsSync(join(dir, 'plan.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found from ' + process.cwd());
    dir = parent;
  }
  return dir;
}

interface Score {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}
interface Report {
  measured: { date: string; commit: string };
  engines: { yaml: { tool: string; version: string } };
  totals: Score;
  bySuite: { suite: string; score: Score }[];
  corpus: { id: string; labels: number; status: string }[];
}

const root = repoRoot();
const report = JSON.parse(readFileSync(join(root, RELEASE_ACCURACY.source), 'utf8')) as Report;

describe('release accuracy (W20-23)', () => {
  it('is published for this release', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')) as {
      version: string;
    };
    expect(RELEASE_ACCURACY.release).toBe(pkg.version);
  });

  it('names a source and a method that exist', () => {
    expect(existsSync(join(root, RELEASE_ACCURACY.source))).toBe(true);
    expect(existsSync(join(root, RELEASE_ACCURACY.method))).toBe(true);
  });

  it('carries the date, commit and engine of the report it was copied from', () => {
    expect(RELEASE_ACCURACY.measured.date).toBe(report.measured.date);
    expect(RELEASE_ACCURACY.measured.commit).toBe(report.measured.commit);
    expect(RELEASE_ACCURACY.measured.engine).toBe(
      `${report.engines.yaml.tool} ${report.engines.yaml.version}`,
    );
  });

  it.each(RELEASE_ACCURACY.rows.map((r) => [r.id, r] as const))(
    '%s matches the report exactly',
    (id, row) => {
      const suite = report.bySuite.find((s) => s.suite === id);
      expect(suite, `no suite ${id} in the report`).toBeDefined();
      const { tp, fp, fn, precision, recall } = suite!.score;
      expect({
        tp: row.tp,
        fp: row.fp,
        fn: row.fn,
        precision: row.precision,
        recall: row.recall,
      }).toEqual({ tp, fp, fn, precision, recall });
      expect(row.from).toBe(`bySuite → ${id}`);
      expect(row.labels).toBe(report.corpus.find((c) => c.id === id)?.labels);
    },
  );

  it('the total is the report total', () => {
    const { tp, fp, fn, precision, recall } = report.totals;
    const t = RELEASE_ACCURACY.total;
    expect({ tp: t.tp, fp: t.fp, fn: t.fn, precision: t.precision, recall: t.recall }).toEqual({
      tp,
      fp,
      fn,
      precision,
      recall,
    });
  });

  it('accounts for every scored suite, shown or said why not', () => {
    const accounted = new Set([
      ...RELEASE_ACCURACY.rows.map((r) => r.id),
      ...RELEASE_ACCURACY.notShown.map((n) => n.id),
    ]);
    const scored = report.corpus.filter((c) => c.status === 'scored').map((c) => c.id);
    expect([...accounted].sort()).toEqual([...scored].sort());
  });

  it('formats a missing score as a dash, never 0% or 100%', () => {
    expect(percent(null)).toBe('—');
    expect(percent(0.826)).toBe('82.6%');
    expect(percent(1)).toBe('100.0%');
  });
});
