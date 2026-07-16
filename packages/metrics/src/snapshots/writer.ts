import { read, type Database } from '@repopulse/shared';

// METRICS.md §2 / FR-METRICS-13. `metric_snapshots` (packages/shared/src/db/
// schema/read/metric-snapshots.ts) is append-only by design (verified: its
// own header comment says "Never updated, never deleted inside retention") -
// a plain INSERT, never an upsert. Two calls for the same
// (workspaceId, repoId, metricKey, window) therefore naturally produce two
// rows distinguished by `computedAt`, satisfying "two nightly runs produce
// two rows" without any extra logic here.
//
// SCOPE NOTE (W3-10, reduced per Brad's explicit instruction): this module
// is the row-writer only. The nightly BullMQ job that CALLS it on a
// schedule (jobId `snap:{repoId}:{yyyymmdd}` per docs/design/INGESTION.md
// §6) needs W2-02's queue topology, which is still blocked on W1-06/W0-05 -
// deferred to whichever ticket builds that.
export interface MetricSnapshotInput {
  workspaceId: number;
  /** null = an org-level rollup row. */
  repoId: number | null;
  /** Catalog id, e.g. 'M1'..'M12' (packages/metrics/src/catalog.ts). */
  metricKey: string;
  window: string;
  value: number;
  numerator: number | null;
  denominator: number | null;
  dims?: Record<string, unknown>;
}

export async function writeMetricSnapshot(db: Database, input: MetricSnapshotInput): Promise<void> {
  await db.insert(read.metricSnapshots).values({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    metricKey: input.metricKey,
    window: input.window,
    // numeric columns are string-typed on the JS side (verified against the
    // installed drizzle-orm 0.39.3 PgNumericBuilder: `data: string`, no
    // numeric `mode` option exists in this version).
    value: String(input.value),
    numerator: input.numerator === null ? null : String(input.numerator),
    denominator: input.denominator === null ? null : String(input.denominator),
    dims: input.dims ?? {},
  });
}
