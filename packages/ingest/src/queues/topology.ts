import type { JobsOptions } from 'bullmq';

// Queue topology — verbatim from INGESTION.md §6 (NFR-11). Queue names, jobId
// idempotency keys and retry policies live here as pure data so they are
// testable without Redis and referenced identically by producers and workers.

export const QUEUE = {
  backfill: 'ingest.backfill',
  delta: 'ingest.delta',
  enrich: 'ingest.enrich',
  reconcile: 'ingest.reconcile',
  snapshot: 'metrics.snapshot',
  dlq: 'ingest.dlq',
  // W5-04. Report generation is user-triggered and slow (a headless print),
  // so it gets its own queue rather than sharing an ingestion lane: a backfill
  // burst must not make someone's report sit behind it, and a stuck print must
  // not stall ingestion.
  reports: 'reports.generate',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

// Queue-level priority mirrors the forge lanes (INGESTION §6): delta >
// user-triggered > backfill > enrich > reconcile. Lower number = higher
// priority in BullMQ.
export const QUEUE_PRIORITY: Record<string, number> = {
  [QUEUE.delta]: 1,
  [QUEUE.backfill]: 3,
  [QUEUE.enrich]: 4,
  [QUEUE.reconcile]: 5,
  [QUEUE.snapshot]: 5,
  // Someone is watching a spinner for this one (UX_SPEC §4.h), so it outranks
  // every background lane except live webhook deltas.
  [QUEUE.reports]: 2,
};

const MIN = 60_000;

// Retry policy per queue (INGESTION §6 table). Exhausted jobs are copied to the
// DLQ (dlq.ts) — removeOnFail:false keeps the failed job inspectable there too.
export const RETRY: Record<string, JobsOptions> = {
  [QUEUE.backfill]: { attempts: 5, backoff: { type: 'exponential', delay: 30_000 } }, // 30s→~30m
  [QUEUE.delta]: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  [QUEUE.enrich]: { attempts: 3, backoff: { type: 'exponential', delay: MIN } },
  [QUEUE.reconcile]: { attempts: 2, backoff: { type: 'exponential', delay: MIN } },
  [QUEUE.snapshot]: { attempts: 3, backoff: { type: 'exponential', delay: MIN } },
  // Two attempts, not five: a print that fails twice is a broken report, not a
  // transient forge hiccup, and a user waiting on a spinner is better served by
  // a fast failure they can see than by 30 minutes of silent retries.
  [QUEUE.reports]: { attempts: 2, backoff: { type: 'exponential', delay: 5_000 } },
};

/** Full default job options for a queue: retry + priority + keep-failed. */
export function defaultJobOptions(queue: QueueName): JobsOptions {
  return {
    ...(RETRY[queue] ?? {}),
    ...(QUEUE_PRIORITY[queue] !== undefined ? { priority: QUEUE_PRIORITY[queue] } : {}),
    removeOnComplete: 1000,
    removeOnFail: false,
  };
}

// jobId builders = the idempotency keys from the §6 table. Re-adding a job with
// the same id is a no-op while it's queued/active, so a duplicate webhook
// delivery or a re-plan never double-processes.
//
// NOTE: the §6 table renders these with `:` separators (bf:{repoId}:{entity}),
// but BullMQ forbids `:` in custom job ids — it uses `:` internally as the Redis
// key separator ("Custom Id cannot contain :", verified empirically by the DLQ
// integration test). We use `-` instead; the idempotency semantics are
// identical, only the separator differs from the doc's illustration.
export const jobId = {
  backfillEntity: (repoId: number, entityType: string): string => `bf-${repoId}-${entityType}`,
  delta: (deliveryId: string, entityType: string): string => `dl-${deliveryId}-${entityType}`,
  push: (repoId: number): string => `push-${repoId}`,
  enrich: (repoId: number, sha: string): string => `en-${repoId}-${sha}`,
  reconcile: (repoId: number, yyyymmdd: string): string => `rc-${repoId}-${yyyymmdd}`,
  snapshot: (repoId: number, yyyymmdd: string): string => `snap-${repoId}-${yyyymmdd}`,
} as const;

/** BullMQ-safe id: strip the `:` BullMQ reserves (used for the DLQ mirror id). */
export function safeJobId(raw: string): string {
  return raw.replace(/:/g, '-');
}
