import { core, type Database } from '@repopulse/shared';

// Delivery dedupe (SC-4, FR-INGEST-6). INSERT ... ON CONFLICT (delivery_id) DO
// NOTHING: a first delivery inserts (→ enqueue), a GitHub redelivery conflicts
// (→ 200 no-op, nothing re-enqueued). The unique delivery_id is the guard.

export interface DeliveryRecord {
  workspaceId: number;
  connectionId: number;
  deliveryId: string;
  event: string;
  action?: string | null;
  repoFullName: string;
  payloadDigest: string;
}

/** Returns true if this delivery is new (enqueue), false if a duplicate. */
export async function recordDelivery(db: Database, rec: DeliveryRecord): Promise<boolean> {
  const inserted = await db
    .insert(core.webhookDelivery)
    .values({
      workspaceId: rec.workspaceId,
      connectionId: rec.connectionId,
      deliveryId: rec.deliveryId,
      event: rec.event,
      action: rec.action ?? null,
      repoFullName: rec.repoFullName,
      payloadDigest: rec.payloadDigest,
    })
    .onConflictDoNothing({ target: core.webhookDelivery.deliveryId })
    .returning({ id: core.webhookDelivery.id });
  return inserted.length > 0;
}
