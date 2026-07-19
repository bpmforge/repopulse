import type { Redis } from 'ioredis';

// Sync event stream (API_DESIGN §3, NFR-10). Workers publish to a per-workspace
// Redis pub/sub channel; the api's SSE endpoint (GET /api/v1/events) relays them
// to the browser (worker→api transport = Redis pub/sub, ARCHITECTURE §4b). The
// UI treats SSE as an optimization — correctness comes from the GET status reads
// — so a dropped event just means a slightly staler dashboard until the next
// poll/reconnect.

export type SyncEventType =
  | 'sync.progress' // a repo's backfill/delta advanced
  | 'sync.done' // a repo reached live
  | 'budget.warning' // forge budget parked / low
  | 'sync.repo'; // generic repo state change (API_DESIGN §3)

export interface SyncStreamEvent {
  type: SyncEventType;
  data: Record<string, unknown>;
}

export function syncEventsChannel(workspaceId: number): string {
  return `sync:events:${workspaceId}`;
}

/** Publish a sync event to a workspace's channel (called from workers). */
export async function publishSyncEvent(
  redis: Redis,
  workspaceId: number,
  event: SyncStreamEvent,
): Promise<void> {
  await redis.publish(syncEventsChannel(workspaceId), JSON.stringify(event));
}
