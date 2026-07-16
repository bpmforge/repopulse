import { median, nearestRankPercentile } from '../engine/percentiles.js';
import { daysBetween } from '../engine/windows.js';

// METRICS.md §1 M10. The real `issues` table (packages/shared/src/db/schema/
// facts/issues.ts, W1-02) stores only the CURRENT `closedAt` plus a
// `reopenedCount` counter - it has no per-cycle timestamps, so a
// reopen->reclose history with dated intervals genuinely cannot be
// reconstructed from that row alone. `closeEvents` here is deliberately
// richer than what that table can supply today; whichever ticket ingests
// GitHub's Issue Events API (a real per-event history) is what would
// populate it - flagged, not silently worked around.
export interface IssueCloseEvent {
  closedAt: string; // ISO
  /** Start of the open period this close event ends: createdAt for the first close, the most recent reopen date for any subsequent one. */
  openPeriodStartedAt: string; // ISO
}

export interface IssueThroughputInput {
  number: number;
  isPullRequest: boolean;
  createdAt: string;
  isOpenAtSnapshot: boolean;
  /** Every close event in this issue's history (reopen+reclose = 2 entries here, per METRICS.md §1 M10). */
  closeEvents: readonly IssueCloseEvent[];
}

function inWindow(at: Date, start: Date, end: Date): boolean {
  return at >= start && at <= end;
}

export interface IssueThroughputCounts {
  opened: number;
  /** Each close event counts once - reopen+reclose = 2 (METRICS.md §1 M10). */
  closed: number;
  medianTimeToCloseDays: number | null;
}

/** METRICS.md §1 M10 opened/closed counts + median time-to-close, isPullRequest=false only. */
export function computeIssueThroughput(
  issues: readonly IssueThroughputInput[],
  windowStart: Date,
  windowEnd: Date,
): IssueThroughputCounts {
  const nonPr = issues.filter((i) => !i.isPullRequest);

  const opened = nonPr.filter((i) =>
    inWindow(new Date(i.createdAt), windowStart, windowEnd),
  ).length;

  const closingIntervalsDays: number[] = [];
  let closed = 0;
  for (const issue of nonPr) {
    for (const event of issue.closeEvents) {
      if (!inWindow(new Date(event.closedAt), windowStart, windowEnd)) continue;
      closed++;
      closingIntervalsDays.push(
        daysBetween(new Date(event.openPeriodStartedAt), new Date(event.closedAt)),
      );
    }
  }

  return { opened, closed, medianTimeToCloseDays: median(closingIntervalsDays) };
}

export interface OpenIssueAgeDistribution {
  p50Days: number | null;
  p90Days: number | null;
  /** Raw ages, for the caller to histogram (no bucket boundaries specified in METRICS.md §1 M10). */
  ageDays: readonly number[];
}

/** METRICS.md §1 M10: open-issue age distribution at snapshot time, isPullRequest=false only. */
export function computeOpenIssueAgeDistribution(
  issues: readonly IssueThroughputInput[],
  asOf: Date,
): OpenIssueAgeDistribution {
  const ageDays = issues
    .filter((i) => !i.isPullRequest && i.isOpenAtSnapshot)
    .map((i) => daysBetween(new Date(i.createdAt), asOf));

  return {
    p50Days: median(ageDays),
    p90Days: nearestRankPercentile(ageDays, 90),
    ageDays,
  };
}
