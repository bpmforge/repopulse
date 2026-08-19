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

export type HealthSnapshotSet = Partial<Record<'M4' | 'M5' | 'M8' | 'M9' | 'M11', HealthSnapshotValue>>;

export interface HealthContext {
  pushedAt: Date | null;
  nowMs: number;
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
  };
}
