import {
  ingestEntityPages,
  type BackfillDeps,
  type BackfillResult,
  type PaginatedEntity,
} from './backfill.js';

// The backfill BullMQ job body (INGESTION §3/§6). One job ingests ≤20 pages of
// one entity then either finishes, re-enqueues itself with its cursor, or (on
// the budget floor) re-enqueues with a delay-to-reset and flips the repo to
// paused_budget. No job ever busy-waits (FR-INGEST-4).

export interface BackfillJobData {
  workspaceId: number;
  repoId: number;
  repo: string; // owner/name
  entityType: PaginatedEntity;
  cursor?: string;
  since?: string;
}

export interface BackfillProcessorDeps extends BackfillDeps {
  /** Re-enqueue the continuation job (BullMQ queue.add wrapped by the runtime). */
  enqueue: (data: BackfillJobData, opts?: { delayMs?: number }) => Promise<void>;
  /** Flip repo sync_status (e.g. → paused_budget). Optional in tests. */
  setRepoStatus?: (repoId: number, status: string) => Promise<void>;
  /** Injectable for tests; defaults to the real page-ingest loop. */
  run?: (data: BackfillJobData) => Promise<BackfillResult>;
  now?: () => number;
}

/** Process one backfill job: ingest a batch of pages, then decide continuation. */
export async function processBackfillJob(
  deps: BackfillProcessorDeps,
  data: BackfillJobData,
): Promise<BackfillResult> {
  const run = deps.run ?? ((d: BackfillJobData) => ingestEntityPages(deps, d));
  const now = deps.now ?? (() => Date.now());
  const result = await run(data);

  if (result.parkedUntilMs !== undefined) {
    // Budget floor: park the repo, re-enqueue after reset — never busy-wait.
    await deps.setRepoStatus?.(data.repoId, 'paused_budget');
    await deps.enqueue(
      { ...data, ...(result.nextCursor ? { cursor: result.nextCursor } : {}) },
      { delayMs: Math.max(0, result.parkedUntilMs - now()) },
    );
  } else if (!result.done) {
    // More pages: re-enqueue immediately with the checkpointed cursor.
    await deps.enqueue({ ...data, ...(result.nextCursor ? { cursor: result.nextCursor } : {}) });
  }
  return result;
}
