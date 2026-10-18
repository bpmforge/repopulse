import type { BenchmarkReport } from './report.js';
import type { Score } from './match.js';

// The regression gate (W19-06).
//
// Compares a fresh benchmark report to the LAST COMMITTED one and names every
// measured row that got worse. The committed report is the ratchet: a number
// that was earned stays earned until a person deliberately re-records it.
//
// A "measured row" is one the committed report scored. A row the new run did
// not measure (an engine that did not start) is NOT a pass: it is reported as
// lost coverage and fails the gate on its own. Otherwise the cheapest way to
// pass would be to measure less.
//
// LOAD. Opengrep timeouts under a busy machine drop findings and look exactly
// like a regression (observed during this wave). So the gate never fails on one
// run: see decideGate — a regression must reproduce on a second run to fail.

export type RowScope = 'totals' | 'dimension' | 'suite' | 'rule' | 'cwe';
export type RegressionMetric = 'tp' | 'fp' | 'fn' | 'tpr' | 'fpr';

export interface RegressionRow {
  scope: RowScope;
  key: string;
  metric: RegressionMetric;
  before: number;
  after: number;
}

export interface Comparison {
  regressions: RegressionRow[];
  /** Committed rows (or whole engines) the new run did not measure. */
  coverageLost: string[];
  /** Rows that improved — shown so a re-record is a deliberate, visible act. */
  improved: number;
  /** Rows compared. */
  compared: number;
}

const WORSE_WHEN_HIGHER = new Set<RegressionMetric>(['fp', 'fn', 'fpr']);

function compareScore(
  scope: RowScope,
  key: string,
  before: Pick<Score, 'tp' | 'fp' | 'fn'>,
  after: Pick<Score, 'tp' | 'fp' | 'fn'>,
  out: Comparison,
): void {
  out.compared += 1;
  for (const metric of ['tp', 'fp', 'fn'] as const) {
    const b = before[metric];
    const a = after[metric];
    const worse = WORSE_WHEN_HIGHER.has(metric) ? a > b : a < b;
    const better = WORSE_WHEN_HIGHER.has(metric) ? a < b : a > b;
    if (worse) out.regressions.push({ scope, key, metric, before: b, after: a });
    else if (better) out.improved += 1;
  }
}

export function compareReports(previous: BenchmarkReport, current: BenchmarkReport): Comparison {
  const out: Comparison = { regressions: [], coverageLost: [], improved: 0, compared: 0 };

  // A suite that was scored and is now NOT PREPARED (its corpus was never
  // fetched on this checkout) makes every total incomparable: thousands of true
  // positives vanish, and listing each derived row would bury the one cause.
  // Report the cause and stop; fixing it is `bench:prepare-*`, not the rules.
  const unprepared = previous.corpus.filter((p) => {
    const c = current.corpus.find((x) => x.id === p.id);
    return p.status === 'scored' && c !== undefined && c.status !== 'scored';
  });
  if (unprepared.length > 0) {
    for (const u of unprepared) {
      out.coverageLost.push(
        `suite "${u.id}" is not prepared on this machine (its corpus has not been fetched) — the totals are not comparable; run the suite's bench:prepare script, then re-run`,
      );
    }
    out.coverageLost.sort();
    return out;
  }

  // Whole engines first: a skipped engine would empty its rows and look like a
  // sea of "not measured", which is true but buries the cause.
  if (previous.engines.yaml.status === 'ran' && current.engines.yaml.status !== 'ran') {
    out.coverageLost.push(
      `the YAML engine did not run (${current.engines.yaml.status === 'unavailable' ? current.engines.yaml.reason : 'unknown'})`,
    );
  }
  if (previous.engines.adapters?.status === 'ran' && current.engines.adapters?.status !== 'ran') {
    out.coverageLost.push('the tool adapters did not run');
  }

  compareScore('totals', 'all', previous.totals, current.totals, out);

  const index = <T, K extends string>(rows: readonly T[], key: (r: T) => K): Map<K, T> =>
    new Map(rows.map((r) => [key(r), r]));

  const scoped: [RowScope, Map<string, { score: Score }>, Map<string, { score: Score }>][] = [
    [
      'dimension',
      index(previous.byDimension, (r) => r.dimension),
      index(current.byDimension, (r) => r.dimension),
    ],
    ['suite', index(previous.bySuite, (r) => r.suite), index(current.bySuite, (r) => r.suite)],
    ['rule', index(previous.byRule, (r) => r.rule), index(current.byRule, (r) => r.rule)],
  ];
  for (const [scope, before, after] of scoped) {
    for (const [key, prev] of before) {
      const cur = after.get(key);
      // A row that scored nothing last time has nothing to regress from.
      if (prev.score.tp + prev.score.fp + prev.score.fn === 0) continue;
      if (!cur) {
        out.coverageLost.push(`${scope} "${key}" is absent from the new run`);
        continue;
      }
      compareScore(scope, key, prev.score, cur.score, out);
    }
  }

  const cwe = new Map<string, (typeof current.byCwe)[number]>(
    current.byCwe.map((r) => [`${r.suite}/${r.cwe}`, r]),
  );
  for (const prev of previous.byCwe) {
    const key = `${prev.suite}/${prev.cwe}`;
    const cur = cwe.get(key);
    if (!cur) {
      out.coverageLost.push(`cwe "${key}" is absent from the new run`);
      continue;
    }
    out.compared += 1;
    if (prev.tpr !== null && cur.tpr !== null && cur.tpr < prev.tpr) {
      out.regressions.push({ scope: 'cwe', key, metric: 'tpr', before: prev.tpr, after: cur.tpr });
    }
    if (prev.fpr !== null && cur.fpr !== null && cur.fpr > prev.fpr) {
      out.regressions.push({ scope: 'cwe', key, metric: 'fpr', before: prev.fpr, after: cur.fpr });
    }
  }

  out.regressions.sort((a, b) =>
    `${a.scope}\u0000${a.key}\u0000${a.metric}`.localeCompare(
      `${b.scope}\u0000${b.key}\u0000${b.metric}`,
    ),
  );
  out.coverageLost.sort();
  return out;
}

export const isClean = (c: Comparison): boolean =>
  c.regressions.length === 0 && c.coverageLost.length === 0;

const signature = (c: Comparison): string =>
  JSON.stringify([c.regressions.map((r) => [r.scope, r.key, r.metric]), c.coverageLost]);

export type GateOutcome =
  /** Clean on the first run. */
  | { status: 'pass'; flagged: false }
  /** Regressed once, clean on the second: load, not the rules. Passes, flagged. */
  | { status: 'pass'; flagged: true; note: string; first: Comparison }
  /** The same rows regressed on both runs. */
  | { status: 'fail'; kind: 'confirmed'; comparison: Comparison }
  /** The two runs disagree with each other and neither is clean. Not trusted either way. */
  | { status: 'fail'; kind: 'unstable'; first: Comparison; second: Comparison };

/**
 * The gate's decision from one run, and a second only when the first was not
 * clean. A failure needs the SAME regression twice: one bad run on a loaded
 * machine is a flag on a passing result, not a red build, and two different bad
 * runs are reported as unstable rather than guessed at.
 */
export async function decideGate(
  runOnce: () => Promise<Comparison>,
  loadNote?: () => string | null,
): Promise<GateOutcome> {
  const first = await runOnce();
  if (isClean(first)) return { status: 'pass', flagged: false };
  const second = await runOnce();
  if (isClean(second)) {
    return {
      status: 'pass',
      flagged: true,
      first,
      note:
        `the first run regressed on ${first.regressions.length} row(s) and ${first.coverageLost.length} coverage loss(es); ` +
        `the second was clean — treated as load, not the rules${loadNote?.() ? ` (${loadNote()})` : ''}`,
    };
  }
  if (signature(first) === signature(second)) {
    return { status: 'fail', kind: 'confirmed', comparison: second };
  }
  return { status: 'fail', kind: 'unstable', first, second };
}

export function describeComparison(c: Comparison): string[] {
  const lines = c.regressions.map(
    (r) => `  REGRESSED ${r.scope} "${r.key}" ${r.metric}: ${r.before} -> ${r.after}`,
  );
  for (const l of c.coverageLost) lines.push(`  NOT MEASURED ${l}`);
  return lines;
}
