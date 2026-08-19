import { and, desc, eq, lt } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import type { ReportParams } from '../types/index.js';

// The previous same-scope report (W5-09).
//
// "Same scope" is deliberately strict: same type, same window, same repo set.
// A looser match would compare a 30-day report against a 90-day one and render
// the difference as movement, which is the most confident way to be wrong.

export async function readPreviousSnapshotAt(
  db: Database,
  params: ReportParams,
): Promise<Date | null> {
  const workspaceId = Number(params.workspaceId);
  const rows = await db
    .select({ params: read.reports.params, generatedAt: read.reports.generatedAt })
    .from(read.reports)
    .where(
      and(
        eq(read.reports.workspaceId, workspaceId),
        eq(read.reports.type, params.type),
        eq(read.reports.status, 'ready'),
        // Strictly EARLIER than this report's pin: a report generated in the
        // same second is not a previous period, and comparing a report to
        // itself would render every delta as zero and look like stagnation.
        lt(read.reports.generatedAt, new Date(params.snapshotAt)),
      ),
    )
    .orderBy(desc(read.reports.generatedAt))
    .limit(10);

  const wanted = [...params.repoIds].sort().join(',');
  for (const row of rows) {
    const p = row.params as unknown as Partial<ReportParams>;
    if (p.windowDays !== params.windowDays) continue;
    if ([...(p.repoIds ?? [])].sort().join(',') !== wanted) continue;
    return p.snapshotAt ? new Date(p.snapshotAt) : row.generatedAt;
  }
  return null;
}
