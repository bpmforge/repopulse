// File drill-down contracts (W4-06). Source of truth is
// apps/api/src/routes/files/index.ts — the API declares no response schemas.

export interface FileDetail {
  path: string;
  /** Per non-merge commit, oldest first. */
  churn_series: { sha: string; authored_at: string; additions: number; deletions: number }[];
  owners: { login: string; lines_changed: number; share: number }[];
  links: { repo: string };
}

/** M3: a file whose top author holds >=80% of changed lines is single-owner. */
export const SINGLE_OWNER_THRESHOLD = 0.8;

export interface WeekBucket {
  /** ISO date of the week start (Monday, UTC). */
  week: string;
  gross: number;
  net: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function startOfWeekUtc(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 24 * 60 * 60 * 1000;
}

/**
 * Bucket per-commit churn into the trailing 52 weeks (UX_SPEC §4.d).
 *
 * Every week in the range is emitted, including empty ones. Plotting only weeks
 * that have commits would compress the gaps and draw a file that was touched
 * twice a year as if it were touched steadily — the quiet periods are the
 * signal here, not padding.
 *
 * gross = additions + deletions (M1's definition), net = additions − deletions.
 * Rework is deliberately NOT computed: M1 defines it as a touch on a file with a
 * prior non-bot touch <21d earlier, which needs per-touch history the endpoint
 * does not return. Showing gross as if it were rework would misstate the metric.
 */
export function toWeeklyChurn(
  series: FileDetail['churn_series'],
  now: number,
  weeks = 52,
): WeekBucket[] {
  const end = startOfWeekUtc(now);
  const start = end - (weeks - 1) * WEEK_MS;

  const buckets = new Map<number, WeekBucket>();
  for (let w = start; w <= end; w += WEEK_MS) {
    buckets.set(w, { week: new Date(w).toISOString().slice(0, 10), gross: 0, net: 0 });
  }

  for (const commit of series) {
    const w = startOfWeekUtc(Date.parse(commit.authored_at));
    const bucket = buckets.get(w);
    // Commits older than the window are dropped rather than clamped into the
    // first bucket, which would invent a spike that never happened.
    if (!bucket) continue;
    bucket.gross += commit.additions + commit.deletions;
    bucket.net += commit.additions - commit.deletions;
  }

  return [...buckets.values()];
}
