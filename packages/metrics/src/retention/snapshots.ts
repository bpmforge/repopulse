import { inArray, lt } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';

// metric_snapshots retention (DATABASE.md §4, FR-METRICS-13). Prunes rows
// OLDER than the ≥400d policy — never inside it (trend/series read ≥400d).
// Batched ranged DELETE (id-keyed) so a huge table doesn't lock in one
// statement; idempotent (a second run finds nothing); the caller wraps it in a
// BullMQ job with DLQ-on-failure (NFR-11).

export const SNAPSHOT_RETENTION_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 5000;

export interface PruneOptions {
  retentionDays?: number;
  nowMs?: number;
  batchSize?: number;
}

export async function pruneMetricSnapshots(db: Database, opts: PruneOptions = {}): Promise<number> {
  const retentionDays = opts.retentionDays ?? SNAPSHOT_RETENTION_DAYS;
  const nowMs = opts.nowMs ?? Date.now();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const cutoff = new Date(nowMs - retentionDays * DAY_MS);

  let total = 0;
  for (;;) {
    const batch = await db
      .select({ id: read.metricSnapshots.id })
      .from(read.metricSnapshots)
      .where(lt(read.metricSnapshots.computedAt, cutoff))
      .limit(batchSize);
    if (batch.length === 0) break;
    await db.delete(read.metricSnapshots).where(
      inArray(
        read.metricSnapshots.id,
        batch.map((r) => r.id),
      ),
    );
    total += batch.length;
    if (batch.length < batchSize) break;
  }
  return total;
}
