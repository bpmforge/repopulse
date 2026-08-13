import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import {
  isHistoryBackfillComplete,
  jobId,
  nextPhase,
  planBackfill,
  processBackfillJob,
  processDeltaJob,
  syncPhaseToRepoStatus,
  PAGINATED_ENTITIES,
  type BackfillJobData,
  type DeltaJobData,
} from '@repopulse/ingest';
import { computeRepoSnapshots } from '@repopulse/metrics';
import { providerForRepo, type WorkerProviderDeps } from './forge-provider.js';

// The queue processors (W12-03).
//
// These functions were all built and unit-tested in W2/W3 and then never
// registered, so the worker consumed nothing and the warehouse was only ever
// populated by the seeder. This module is the missing wiring, kept separate
// from the entrypoint so it can be tested without booting a worker.

export interface ProcessorDeps extends WorkerProviderDeps {
  /** Re-enqueue onto the backfill queue (continuations and planned entities). */
  backfillQueue: Queue;
  snapshotQueue: Queue;
}

/** `plan` job: fan a connected repo out into one backfill job per entity type. */
async function processPlan(deps: ProcessorDeps, data: { workspaceId: number; repoId: number }) {
  const [repo] = await deps.db
    .select({ id: core.repos.id, pushedAt: core.repos.pushedAt })
    .from(core.repos)
    .where(and(eq(core.repos.id, data.repoId), eq(core.repos.workspaceId, data.workspaceId)))
    .limit(1);
  if (!repo) return { planned: 0 };

  const specs = planBackfill(
    [{ repoId: repo.id, pushedAt: repo.pushedAt ? repo.pushedAt.toISOString() : null }],
    Date.now(),
  );
  const resolved = await providerForRepo(deps, data.workspaceId, data.repoId);
  if (!resolved) return { planned: 0 };

  // The planner orders 'checks' alongside the paginated entities, but checks are
  // fetched per-PR through the enrich lane, not walked page-by-page at repo
  // scope — processBackfillJob only accepts PaginatedEntity. Route the paginated
  // ones here and leave checks to the enrich processor (still unwired, W12-03).
  const paginated = specs.filter(
    (spec): spec is typeof spec & { entityType: (typeof PAGINATED_ENTITIES)[number] } =>
      (PAGINATED_ENTITIES as readonly string[]).includes(spec.entityType),
  );

  for (const spec of paginated) {
    // jobId comes from the planner so a re-planned repo collapses onto the same
    // jobs instead of duplicating an entire backfill.
    await deps.backfillQueue.add(
      spec.entityType,
      {
        workspaceId: data.workspaceId,
        repoId: spec.repoId,
        repo: resolved.repoFullName,
        entityType: spec.entityType,
        since: spec.since,
      } satisfies BackfillJobData,
      { jobId: spec.jobId },
    );
  }
  // queued --plan_ran--> history, which stores as 'backfilling'. Guarded on the
  // current value rather than written blindly: a re-planned repo that is
  // already backfilling (or paused_budget) must not be dragged backwards, and
  // 0 rows affected is a normal outcome, not an error. The target comes from
  // the state machine (plan/state-machine.ts) instead of a literal — that
  // module defined the whole lifecycle and had no production caller at all.
  await deps.db
    .update(core.repos)
    .set({ syncStatus: syncPhaseToRepoStatus(nextPhase('queued', 'plan_ran')) })
    .where(and(eq(core.repos.id, data.repoId), eq(core.repos.syncStatus, 'pending_backfill')));

  return { planned: paginated.length, deferredToEnrich: specs.length - paginated.length };
}

/**
 * Called when an entity job finishes: if that was the LAST outstanding entity,
 * compute metrics over what ingestion actually wrote.
 *
 * The snapshot used to be enqueued by processPlan, immediately after the
 * fan-out — so it ran BEFORE any entity job had written a row and every metric
 * landed as 0.000000 over an empty warehouse. That is the real reason the
 * dashboard has always rendered without ever showing ingested data.
 *
 * No lock is needed: the five entity jobs can finish concurrently and all
 * observe "complete", but they all derive the SAME snapshot jobId, and BullMQ
 * treats a re-add with an existing custom jobId as a no-op. The idempotency key
 * from the §6 topology table is the election.
 */
async function maybeSnapshot(deps: ProcessorDeps, data: BackfillJobData): Promise<boolean> {
  if (!(await isHistoryBackfillComplete(deps.db, data.repoId))) return false;
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await deps.snapshotQueue.add(
    'compute',
    { workspaceId: data.workspaceId, repoId: data.repoId },
    { jobId: jobId.snapshot(data.repoId, yyyymmdd) },
  );
  return true;
}

/** The backfill queue carries both the `plan` fan-out and the entity pages. */
export function backfillProcessor(deps: ProcessorDeps) {
  return async (job: Job) => {
    if (job.name === 'plan') {
      return processPlan(deps, job.data as { workspaceId: number; repoId: number });
    }
    const data = job.data as BackfillJobData;
    const resolved = await providerForRepo(deps, data.workspaceId, data.repoId);
    // A purged connection mid-backfill is expected, not exceptional: end the
    // job quietly rather than failing it into the DLQ forever.
    if (!resolved) return { skipped: 'no active connection' };

    const result = await processBackfillJob(
      {
        db: deps.db,
        provider: resolved.provider,
        enqueue: async (next, opts) => {
          await deps.backfillQueue.add(next.entityType, next, {
            ...(opts?.delayMs === undefined ? {} : { delay: opts.delayMs }),
          });
        },
        setRepoStatus: async (repoId, status) => {
          await deps.db
            .update(core.repos)
            .set({ syncStatus: status })
            .where(eq(core.repos.id, repoId));
        },
      },
      data,
    );

    // Only a finished entity can complete the repo. A continuation (more pages)
    // or a budget park is explicitly not done, and asking on every page would
    // be a needless query per page.
    const snapshotQueued = result.done === true ? await maybeSnapshot(deps, data) : false;
    return { ...result, ...(snapshotQueued ? { snapshotQueued: true } : {}) };
  };
}

/** Webhook deltas — accepted by the receiver since W2-04 and never applied until now. */
export function deltaProcessor(deps: ProcessorDeps) {
  return async (job: Job) => {
    const data = job.data as DeltaJobData;
    const resolved = await providerForRepo(deps, data.workspaceId, data.repoId);
    if (!resolved) return { skipped: 'no active connection' };
    return processDeltaJob({ db: deps.db, provider: resolved.provider }, data);
  };
}

/** Metric snapshots — the numbers every screen reads. */
export function snapshotProcessor(deps: ProcessorDeps) {
  return async (job: Job) => {
    const data = job.data as { workspaceId: number; repoId: number };
    const written = await computeRepoSnapshots(deps.db, {
      workspaceId: data.workspaceId,
      repoId: data.repoId,
      asOf: new Date(),
      botGlobs: [],
    });
    return { written };
  };
}
