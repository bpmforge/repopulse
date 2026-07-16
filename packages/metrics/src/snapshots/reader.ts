import { and, desc, eq, isNull } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';

// FR-METRICS-13 acceptance: "trend queries read snapshots only". This
// module deliberately imports nothing from ../engine or ../metrics - it is
// a pure DB read, structurally incapable of triggering recomputation
// (there is nothing here to recompute with). A future ops/observability
// ticket can assert this via an import-graph lint rule if desired; the
// absence of any compute-module import is itself the guarantee today.
export interface MetricSnapshotRow {
  repoId: number | null;
  metricKey: string;
  window: string;
  value: string;
  numerator: string | null;
  denominator: string | null;
  dims: Record<string, unknown>;
  computedAt: Date;
}

export interface ReadMetricTrendParams {
  workspaceId: number;
  /** null = read the org-level rollup series. */
  repoId: number | null;
  metricKey: string;
  window: string;
  limit?: number;
}

const DEFAULT_TREND_LIMIT = 100;

/** FR-METRICS-13: trend queries read `metric_snapshots` only, newest first. */
export async function readMetricTrend(
  db: Database,
  params: ReadMetricTrendParams,
): Promise<MetricSnapshotRow[]> {
  const repoCondition =
    params.repoId === null
      ? isNull(read.metricSnapshots.repoId)
      : eq(read.metricSnapshots.repoId, params.repoId);

  const rows = await db
    .select()
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, params.workspaceId),
        repoCondition,
        eq(read.metricSnapshots.metricKey, params.metricKey),
        eq(read.metricSnapshots.window, params.window),
      ),
    )
    .orderBy(desc(read.metricSnapshots.computedAt))
    .limit(params.limit ?? DEFAULT_TREND_LIMIT);

  return rows;
}
