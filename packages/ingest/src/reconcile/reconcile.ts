import { and, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { ingestEntityPages, type PaginatedEntity } from '../backfill/backfill.js';
import { _highWatermark } from '../webhooks/delta.js';
import { withoutStallFragments } from '../queues/stall.js';

// Nightly reconciliation sweep (INGESTION §5, FR-INGEST-7). Lane=reconcile,
// runs per repo. Real forge calls go through the BudgetedClient, whose ETag
// cache makes an unchanged page-1 list a 304 (~0 primary budget, research §2);
// a 200 walks pages until updated_at ≤ high-watermark, upserting — which is
// exactly what repairs a missed webhook / force-push / late delivery. Idempotent
// upserts (W2-03) mean re-running is free of duplicates.

// The repo-wide entities a sweep re-lists (checks/reviews are nested; tombstoning
// force-pushed/deleted rows needs a `superseded` column METRICS §0 references but
// W1-02's schema lacks — documented gap, not silently wrong).
const SWEEP_ENTITIES: PaginatedEntity[] = ['prs', 'commits', 'issues', 'releases', 'deployments'];

export interface ReconcileDeps {
  db: Database;
  provider: ForgeProvider;
  maxPagesPerEntity?: number;
  overlapMs?: number;
}

export interface ReconcileRepoParams {
  workspaceId: number;
  repoId: number;
  repo: string; // owner/name
}

const DEFAULT_OVERLAP_MS = 60 * 60 * 1000;

/**
 * Sweep one repo: re-list each entity from its high-watermark and upsert. Any
 * gap (a PR a missed webhook never delivered) is repaired. Returns per-entity
 * item counts.
 */
export async function reconcileRepo(
  deps: ReconcileDeps,
  params: ReconcileRepoParams,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entity of SWEEP_ENTITIES) {
    const since = await _highWatermark(
      deps.db,
      params.repoId,
      entity,
      deps.overlapMs ?? DEFAULT_OVERLAP_MS,
    );
    const result = await ingestEntityPages(
      { db: deps.db, provider: deps.provider, maxPagesPerJob: deps.maxPagesPerEntity ?? 10 },
      {
        workspaceId: params.workspaceId,
        repoId: params.repoId,
        repo: params.repo,
        entityType: entity,
        lane: 'reconcile',
        ...(since ? { since } : {}),
      },
    );
    counts[entity] = result.itemsTotal;
  }
  // Mark the repo swept.
  await deps.db
    .update(core.repos)
    .set({ lastSyncedAt: new Date() })
    .where(eq(core.repos.id, params.repoId));
  return counts;
}

export interface RequeueDeps {
  db: Database;
  /** Enqueue a backfill plan for a repo (BullMQ, W2-02). */
  enqueuePlan: (params: { workspaceId: number; repoId: number }) => Promise<void>;
}

/**
 * Requeue any repo stuck in `error`: flip it back to pending_backfill and
 * re-enqueue its plan (INGESTION §5). Returns the requeued repo ids.
 */
export async function requeueErrorRepos(deps: RequeueDeps, workspaceId: number): Promise<number[]> {
  const errored = await deps.db
    .select({ id: core.repos.id, lastError: core.repos.lastError })
    .from(core.repos)
    .where(and(eq(core.repos.workspaceId, workspaceId), eq(core.repos.syncStatus, 'error')));
  const requeued: number[] = [];
  for (const r of errored) {
    // Clear only the stall this retry answers (W17-41). The rest of the line is
    // per-entity refusals (W17-35/38) and the webhook-registration failure,
    // which a re-plan does not re-record for entities that already finished.
    await deps.db
      .update(core.repos)
      .set({ syncStatus: 'pending_backfill', lastError: withoutStallFragments(r.lastError) })
      .where(eq(core.repos.id, r.id));
    await deps.enqueuePlan({ workspaceId, repoId: r.id });
    requeued.push(r.id);
  }
  return requeued;
}
