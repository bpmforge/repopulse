import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { core, read, type Database } from '@repopulse/shared';

// Snapshot reads bounded by `snapshotAt` (W5-03, REPORTS.md §2).
//
// packages/metrics' readMetricTrend deliberately reads the NEWEST rows with no
// upper bound — correct for a live screen, fatal for a report: regenerating an
// hour later would pick up newer snapshots and produce different numbers from
// identical ReportParams. Everything here filters computed_at <= snapshotAt,
// which is the entire determinism guarantee.

export interface BoundedSnapshot {
  repoId: number | null;
  metricKey: string;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  dims: Record<string, unknown>;
  computedAt: Date;
}

/**
 * The newest snapshot per (repo, metric) at or before `snapshotAt`.
 *
 * One query for every metric and repo in the report rather than N round trips:
 * a 20-repo org report would otherwise issue 200+ queries against the same
 * table and blow the NFR-3 budget on assembly alone.
 */
export async function readSnapshotsAsOf(
  db: Database,
  params: {
    workspaceId: number;
    repoIds: number[];
    metricKeys: string[];
    window: string;
    snapshotAt: Date;
    /** true = read the org-level rollup rows (repo_id IS NULL) instead. */
    orgLevel?: boolean;
  },
): Promise<Map<string, BoundedSnapshot>> {
  const rows = await db
    .select()
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, params.workspaceId),
        params.orgLevel
          ? isNull(read.metricSnapshots.repoId)
          : inArray(read.metricSnapshots.repoId, params.repoIds.length > 0 ? params.repoIds : [-1]),
        inArray(read.metricSnapshots.metricKey, params.metricKeys),
        eq(read.metricSnapshots.window, params.window),
        lte(read.metricSnapshots.computedAt, params.snapshotAt),
      ),
    )
    .orderBy(desc(read.metricSnapshots.computedAt));

  // First row wins per key because the query is newest-first — the "latest at
  // or before the pin", which is what §2 means by reading as of a snapshot.
  const latest = new Map<string, BoundedSnapshot>();
  for (const r of rows) {
    const key = `${r.repoId ?? 'org'}:${r.metricKey}`;
    if (latest.has(key)) continue;
    latest.set(key, {
      repoId: r.repoId,
      metricKey: r.metricKey,
      value: r.value === null ? null : Number(r.value),
      numerator: r.numerator === null ? null : Number(r.numerator),
      denominator: r.denominator === null ? null : Number(r.denominator),
      dims: (r.dims ?? {}) as Record<string, unknown>,
      computedAt: r.computedAt,
    });
  }
  return latest;
}

export interface ReportRepo {
  id: number;
  org: string;
  name: string;
  syncStatus: string;
  pushedAt: Date | null;
}

/** The repos in scope, workspace-filtered (Law 5) — never trust the id list alone. */
export async function readReportRepos(
  db: Database,
  workspaceId: number,
  repoIds: number[],
): Promise<ReportRepo[]> {
  if (repoIds.length === 0) return [];
  const rows = await db
    .select({
      id: core.repos.id,
      org: core.repos.org,
      name: core.repos.name,
      syncStatus: core.repos.syncStatus,
      pushedAt: core.repos.pushedAt,
    })
    .from(core.repos)
    .where(and(eq(core.repos.workspaceId, workspaceId), inArray(core.repos.id, repoIds)))
    .orderBy(core.repos.org, core.repos.name);
  return rows;
}
