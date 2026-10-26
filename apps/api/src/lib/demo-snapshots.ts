import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { computeRepoSnapshots, writeMetricSnapshot } from '@repopulse/metrics';
import { read, type Database } from '@repopulse/shared';
import { combineRows } from './scope-metrics.js';
import { readWorkspaceSettings } from './workspace-settings.js';

// W21-01: the demo's newest snapshots are computed, not invented.
//
// The seeder writes a SYNTHETIC snapshot series (a random walk per metric, so
// sparklines move), and a preset window reads the newest of those rows. A
// custom date range is computed live from the seeded facts (W20-20). So the
// tour showed review coverage at 44.6% of 24 PRs for "30 days" and 100% of 6
// PRs for the last thirty days chosen by date — two answers to one question.
// Production has no such gap: the nightly job and the range reader use the
// same readers and the same functions.
//
// This gives the demo what production has: the nightly job's own driver
// computes every repository's snapshots from the seeded facts, and the
// org-level rollup row the seeder also writes gets a newest point that pools
// those repositories (the same combine the API uses for a repository set).
// The synthetic history stays behind it, so the sparklines still have points.
export async function computeDemoSnapshots(
  db: Database,
  workspaceId: number,
  repoIds: readonly number[],
  asOf: Date = new Date(),
): Promise<number> {
  const { effective } = await readWorkspaceSettings(db, workspaceId);
  let written = 0;
  for (const repoId of repoIds) {
    written += await computeRepoSnapshots(db, {
      workspaceId,
      repoId,
      asOf,
      botGlobs: effective.botLoginGlobs,
      staleThresholdDays: effective.stalePrDays,
    });
  }
  if (repoIds.length === 0) return written;

  // The rows just written are the newest per (repository, metric, window).
  const rows = await db
    .select({
      repoId: read.metricSnapshots.repoId,
      metricKey: read.metricSnapshots.metricKey,
      window: read.metricSnapshots.window,
      value: read.metricSnapshots.value,
      numerator: read.metricSnapshots.numerator,
      denominator: read.metricSnapshots.denominator,
      dims: read.metricSnapshots.dims,
      computedAt: read.metricSnapshots.computedAt,
    })
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, workspaceId),
        isNotNull(read.metricSnapshots.repoId),
        inArray(read.metricSnapshots.repoId, [...repoIds]),
      ),
    );
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.repoId}|${row.metricKey}|${row.window}`;
    const seen = newest.get(key);
    if (!seen || new Date(row.computedAt) > new Date(seen.computedAt)) newest.set(key, row);
  }
  const groups = new Map<string, (typeof rows)[number][]>();
  for (const row of newest.values()) {
    const key = `${row.metricKey}|${row.window}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, group] of groups) {
    const [metricKey, window] = key.split('|') as [string, string];
    const pooled = combineRows(
      metricKey,
      group.map((r) => ({ ...r, dims: r.dims ?? {} })),
    );
    if (pooled.value === null) continue;
    const ratio = group.every((r) => r.numerator !== null && r.denominator !== null);
    await writeMetricSnapshot(db, {
      workspaceId,
      repoId: null,
      metricKey,
      window,
      value: pooled.value,
      numerator: ratio ? group.reduce((s, r) => s + Number(r.numerator), 0) : null,
      denominator: ratio ? group.reduce((s, r) => s + Number(r.denominator), 0) : null,
      dims: pooled.dims,
    });
    written += 1;
  }
  return written;
}
