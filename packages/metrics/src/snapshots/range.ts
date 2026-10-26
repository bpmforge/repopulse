import { and, eq, inArray } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { computeChurn } from '../metrics/churn.js';
import { computeCiPassRate, type CiRunInput } from '../metrics/ci.js';
import { computeCycleStagePercentiles, type CyclePr } from '../metrics/cycle.js';
import { computeIssueThroughput } from '../metrics/issues.js';
import { computeReviewCoverage } from '../metrics/review-coverage.js';
import {
  readChurnTouches,
  readCiRuns,
  readCyclePrs,
  readIssues,
  readReviewCoveragePrs,
} from './readers.js';

// Headline metrics for an arbitrary past date range (W20-20, UX_TODO DSH-56).
//
// Snapshots exist per PRESET window ending on the night they were taken, so a
// "last sprint" or "September" had no numbers of its own: the window control
// read it through the smallest preset ending today. This computes the five KPI
// tiles' metrics (M1 churn, M4 cycle time, M5 review coverage, M9 CI pass rate,
// M10 issue throughput) live from the warehouse for exactly [start, end), with
// the same readers and pure functions the nightly job uses — so a range that
// happens to match a preset gives the preset's numbers.
//
// A set of repositories is pooled from raw inputs, which is better than the
// snapshot rollup can do: M4's median is the median of every PR in the set
// (not the worst repository's), and the ratios pool their parts.
//
// Presets stay on snapshots (fast); this runs only for a custom range.

export const RANGE_HEADLINE_METRICS = ['M5', 'M9', 'M4', 'M1', 'M10'] as const;
export type RangeHeadlineKey = (typeof RANGE_HEADLINE_METRICS)[number];

export interface RangeMetric {
  /** null = nothing to measure in the range (no merged PRs, no CI runs). */
  value: number | null;
  numerator: number | null;
  denominator: number | null;
}

export interface RangeHeadlineParams {
  workspaceId: number;
  /** Empty = every repository in the workspace. */
  repoIds: readonly number[];
  start: Date;
  /** Exclusive. */
  end: Date;
  botGlobs?: readonly string[] | undefined;
}

/** Longest custom range served (a bit over a year, like the 365d preset). */
export const MAX_RANGE_DAYS = 366;

export interface RangeHeadline {
  metrics: Record<RangeHeadlineKey, RangeMetric>;
  /**
   * How many inputs the range held: commit touches, pull requests, CI runs and
   * issues closed (W21-01). Zero means the range has nothing in it at all —
   * typically a period from before the history that was synced — and then no
   * metric of it is a fair comparison, not even a count: "1,840 lines, up from
   * 0" said the team went from idle to busy when the truth was that nothing
   * from back then had been loaded, while the rates beside it said "no prior
   * period". The caller treats such a period as missing for every tile.
   */
  activity: number;
}

export async function computeRangeHeadline(
  db: Database,
  p: RangeHeadlineParams,
): Promise<RangeHeadline> {
  const repos = await db
    .select({ id: core.repos.id })
    .from(core.repos)
    .where(
      and(
        eq(core.repos.workspaceId, p.workspaceId),
        p.repoIds.length > 0 ? inArray(core.repos.id, [...p.repoIds]) : undefined,
      ),
    );

  const bounds = { end: p.end, workspaceId: p.workspaceId };
  let churn = 0;
  let churnMeasured = false;
  let covered = 0;
  let merged = 0;
  let closed = 0;
  const cyclePrs: CyclePr[] = [];
  const ciRuns: CiRunInput[] = [];
  let activity = 0;

  for (const { id } of repos) {
    const [touches, coverage, cycle, runs, issues] = await Promise.all([
      readChurnTouches(db, id, p.start, bounds),
      readReviewCoveragePrs(db, id, p.start, p.botGlobs, bounds),
      readCyclePrs(db, id, p.start, p.botGlobs, bounds),
      readCiRuns(db, id, p.start, bounds),
      readIssues(db, id, bounds),
    ]);
    churn += computeChurn(touches, p.botGlobs).gross;
    churnMeasured = true;
    const cov = computeReviewCoverage(coverage);
    covered += cov.covered;
    merged += cov.merged;
    // Loops, not push(...array): a spread passes one argument per element and
    // throws RangeError (call stack) at about 125k, which a year of CI runs
    // across many repos reaches.
    for (const pr of cycle) cyclePrs.push(pr);
    // M9's value is the DEFAULT-BRANCH pass rate (compute.ts); PR runs are a dim.
    for (const r of runs) if (r.pullRequestId === null) ciRuns.push(r);
    const closedHere = computeIssueThroughput(issues, p.start, p.end).closed;
    closed += closedHere;
    activity += touches.length + coverage.length + runs.length + closedHere;
  }

  const completed = ciRuns.filter(
    (r) => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped',
  );
  const passed = completed.filter((r) => r.conclusion === 'success').length;

  const metrics: Record<RangeHeadlineKey, RangeMetric> = {
    M5: {
      value: merged > 0 ? covered / merged : null,
      numerator: covered,
      denominator: merged,
    },
    M9: {
      value: computeCiPassRate(ciRuns),
      numerator: passed,
      denominator: completed.length,
    },
    M4: {
      value: computeCycleStagePercentiles(cyclePrs).e2e.median,
      numerator: null,
      denominator: null,
    },
    M1: { value: churnMeasured ? churn : null, numerator: null, denominator: null },
    M10: { value: repos.length > 0 ? closed : null, numerator: null, denominator: null },
  };
  return { metrics, activity };
}

/**
 * The exact [start, end) instants for an ISO `from..to` day range, `to`
 * INCLUSIVE (a range 2026-09-01..2026-09-14 is fourteen whole UTC days), and the
 * equally long period right before it for the delta. Null when the range is
 * malformed, reversed, ends in the future or is longer than MAX_RANGE_DAYS.
 */
export function rangeBounds(
  from: string,
  to: string,
  now: Date = new Date(),
): { start: Date; end: Date; days: number; previous: { start: Date; end: Date } } | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(from) || !iso.test(to)) return null;
  const start = new Date(`${from}T00:00:00Z`);
  const lastDay = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(lastDay.getTime())) return null;
  // Round-trip check rejects 2026-02-31 (Date rolls it into March).
  if (start.toISOString().slice(0, 10) !== from || lastDay.toISOString().slice(0, 10) !== to) {
    return null;
  }
  if (lastDay < start) return null;
  const todayUtc = now.toISOString().slice(0, 10);
  if (to > todayUtc) return null;
  const DAY = 86_400_000;
  const end = new Date(lastDay.getTime() + DAY);
  const days = Math.round((end.getTime() - start.getTime()) / DAY);
  if (days > MAX_RANGE_DAYS) return null;
  return {
    start,
    end,
    days,
    previous: { start: new Date(start.getTime() - days * DAY), end: start },
  };
}
