import type { HealthMetricInputs } from './health.js';

// Mapping from metric snapshots to health inputs (W5-03).
//
// This lived inside apps/api/src/routes/org/health.ts, where the reports
// package cannot reach it (Law 6: reports never imports api). The report's
// score-breakdown section shows the SAME decomposition the repo screen shows,
// so a second copy of this mapping is how a report and a screen end up
// disagreeing about one repo's score — with no test able to catch it, because
// each would be self-consistent.
//
// Pure: it takes already-read snapshot values and returns inputs. Reading is
// the caller's job, which is what lets the assembler bound its reads by
// `snapshotAt` (REPORTS.md §2 determinism) while the API route reads latest.

const DAY_MS = 24 * 60 * 60 * 1000;

/** One metric's latest snapshot, reduced to what the health inputs need. */
export interface HealthSnapshotValue {
  value: number | null;
  dims: Record<string, unknown>;
}

export type HealthSnapshotSet = Partial<
  Record<
    // W9-06 adds the code-health series (M13 rework, and the ch_* posture
    // numbers the scanner writes). They are OPTIONAL members of the same set
    // rather than a second parameter: a caller that has not run the scanners
    // simply does not have the keys, which is the same shape as every other
    // absent metric here.
    'M4' | 'M5' | 'M8' | 'M9' | 'M11' | 'M13' | 'ch_duplication_pct' | 'ch_complexity_p90',
    HealthSnapshotValue
  >
>;

export interface HealthContext {
  pushedAt: Date | null;
  nowMs: number;
}

/** Findings inputs, supplied by callers that have analysed the repo (W6-03). */
export interface HealthFindingInputs {
  /** W9-06: slop findings per 1000 changed lines, null until scanned. */
  slopDensity?: number | null;
  openFindingDensity: number | null;
  worstOpenSeverity: number | null;
}

/** Reads a nested numeric dim, or null when any hop is missing. */
export function dimNum(dims: Record<string, unknown>, path: string[]): number | null {
  let cur: unknown = dims;
  for (const k of path) {
    if (cur && typeof cur === 'object' && k in cur) cur = (cur as Record<string, unknown>)[k];
    else return null;
  }
  return typeof cur === 'number' ? cur : null;
}

const EMPTY: HealthSnapshotValue = { value: null, dims: {} };

/**
 * Snapshots → health inputs. Absent metrics stay NULL rather than becoming 0:
 * null is excluded from its sub-score's mean, while 0 would score the repo as
 * having the worst possible value for something never measured.
 */
export function healthInputsFromSnapshots(
  snapshots: HealthSnapshotSet,
  ctx: HealthContext,
  findings: HealthFindingInputs = { openFindingDensity: null, worstOpenSeverity: null },
): HealthMetricInputs {
  const m4 = snapshots.M4 ?? EMPTY;
  const m5 = snapshots.M5 ?? EMPTY;
  const m8 = snapshots.M8 ?? EMPTY;
  const m9 = snapshots.M9 ?? EMPTY;
  const m11 = snapshots.M11 ?? EMPTY;

  return {
    commitCountVsMedian: null,
    daysSinceLastPush: ctx.pushedAt ? (ctx.nowMs - ctx.pushedAt.getTime()) / DAY_MS : null,
    m5ReviewCoverage: m5.value,
    medianFirstReviewHours: dimNum(m4.dims, ['stages', 'openToFirstReview', 'median']),
    stalePrCount: m8.value,
    // W4-15: M9's `value` is the DEFAULT-BRANCH pass rate and `dims.passRate`
    // is the same number; the PR pass rate is a separate dim. Reading `value`
    // as a fallback is safe only because of that — it is not a generic default.
    m9PassRate: dimNum(m9.dims, ['passRate']) ?? m9.value,
    topFlakiness: dimNum(m9.dims, ['topFlakiness']),
    e2eCycleP50Hours: m4.value,
    m11DaysSinceRelease: dimNum(m11.dims, ['daysSinceLast']),
    m12Cfr: null,
    // Snapshots do not carry findings; the callers that HAVE them (the repo
    // route once W6-04 lands) pass them in. Null here means "not analysed",
    // which drops the security sub-score and renormalizes — never "secure".
    openFindingDensity: findings.openFindingDensity,
    worstOpenSeverity: findings.worstOpenSeverity,
    // W9-06: read from the ch_* snapshots the code-health scanner writes, and
    // null until it has run. Same rule as the findings inputs above — a repo
    // nobody has measured drops the sub-score rather than scoring well on it.
    duplicationPct: snapshots.ch_duplication_pct?.value ?? null,
    complexityP90: snapshots.ch_complexity_p90?.value ?? null,
    slopDensity: findings.slopDensity ?? null,
    rework14d: snapshots.M13?.value ?? null,
  };
}
