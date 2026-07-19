import { and, eq, inArray, lt } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';

// Ingest-side retention sweeps (DATABASE.md §4, NFR-11). forge_etag = 90-day
// LRU (by fetched_at); webhook_delivery = 30 days (by received_at). Batched,
// idempotent, id-keyed where possible. The caller wraps each in a BullMQ job
// with DLQ-on-failure.
//
// IMMUTABILITY: no sweep here (or in metrics/retention) touches `reports` or
// `egress_audit` — those are append-only audit surfaces (SRS §5 A3, NFR-9).
// The set of tables any sweep may prune is exactly {metric_snapshots,
// forge_etag, webhook_delivery}; asserted in the tests.

export const SWEEPABLE_TABLES = ['metric_snapshots', 'forge_etag', 'webhook_delivery'] as const;
export const IMMUTABLE_TABLES = ['reports', 'egress_audit'] as const;

export const ETAG_RETENTION_DAYS = 90;
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH = 5000;

export interface SweepOptions {
  nowMs?: number;
  batchSize?: number;
}

/** webhook_delivery: prune deliveries older than 30 days (id-keyed batches). */
export async function pruneWebhookDelivery(db: Database, opts: SweepOptions = {}): Promise<number> {
  const nowMs = opts.nowMs ?? Date.now();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const cutoff = new Date(nowMs - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS);

  let total = 0;
  for (;;) {
    const batch = await db
      .select({ id: core.webhookDelivery.id })
      .from(core.webhookDelivery)
      .where(lt(core.webhookDelivery.receivedAt, cutoff))
      .limit(batchSize);
    if (batch.length === 0) break;
    await db.delete(core.webhookDelivery).where(
      inArray(
        core.webhookDelivery.id,
        batch.map((r) => r.id),
      ),
    );
    total += batch.length;
    if (batch.length < batchSize) break;
  }
  return total;
}

/** forge_etag: 90-day LRU by fetched_at. Composite PK (connectionId, endpointKey). */
export async function pruneForgeEtag(db: Database, opts: SweepOptions = {}): Promise<number> {
  const nowMs = opts.nowMs ?? Date.now();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const cutoff = new Date(nowMs - ETAG_RETENTION_DAYS * DAY_MS);

  let total = 0;
  for (;;) {
    const batch = await db
      .select({
        connectionId: core.forgeEtag.connectionId,
        endpointKey: core.forgeEtag.endpointKey,
      })
      .from(core.forgeEtag)
      .where(lt(core.forgeEtag.fetchedAt, cutoff))
      .limit(batchSize);
    if (batch.length === 0) break;
    // Delete this batch by its composite keys.
    for (const row of batch) {
      await db
        .delete(core.forgeEtag)
        .where(
          and(
            eq(core.forgeEtag.connectionId, row.connectionId),
            eq(core.forgeEtag.endpointKey, row.endpointKey),
          ),
        );
    }
    total += batch.length;
    if (batch.length < batchSize) break;
  }
  return total;
}
