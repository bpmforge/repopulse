import { and, desc, eq, isNull } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';

// Trend deltas (FR-INSIGHTS-4): a metric's latest snapshot value vs the value
// from one equal-length window earlier in the nightly snapshot series. A
// missing prior window ⇒ delta null (never fabricate a zero). Reads
// metric_snapshots only — trend endpoints never recompute (FR-METRICS-13).

const WINDOW_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

export interface TrendResult {
  metricKey: string;
  window: string;
  current: number | null;
  previous: number | null;
  /** current − previous; null when either side is missing. */
  delta: number | null;
}

export interface TrendParams {
  workspaceId: number;
  repoId: number | null; // null = org-rollup series
  metricKey: string;
  window: string;
}

export async function computeMetricTrend(db: Database, params: TrendParams): Promise<TrendResult> {
  const repoCond =
    params.repoId === null
      ? isNull(read.metricSnapshots.repoId)
      : eq(read.metricSnapshots.repoId, params.repoId);
  const rows = await db
    .select({ value: read.metricSnapshots.value, computedAt: read.metricSnapshots.computedAt })
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, params.workspaceId),
        repoCond,
        eq(read.metricSnapshots.metricKey, params.metricKey),
        eq(read.metricSnapshots.window, params.window),
      ),
    )
    .orderBy(desc(read.metricSnapshots.computedAt));

  const base: TrendResult = {
    metricKey: params.metricKey,
    window: params.window,
    current: null,
    previous: null,
    delta: null,
  };
  if (rows.length === 0) return base;

  const current = Number(rows[0]!.value);
  const currentAt = rows[0]!.computedAt.getTime();
  const windowMs = (WINDOW_DAYS[params.window] ?? 30) * 24 * 60 * 60 * 1000;
  // The most recent snapshot at least one window-length before the current one.
  const prior = rows.slice(1).find((r) => r.computedAt.getTime() <= currentAt - windowMs);
  const previous = prior ? Number(prior.value) : null;

  return {
    ...base,
    current,
    previous,
    delta: previous === null ? null : current - previous,
  };
}
