import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import {
  planBackfill,
  processBackfillJob,
  processDeltaJob,
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
  const PAGINATED = ['prs', 'commits', 'issues', 'releases', 'deployments'] as const;
  const paginated = specs.filter(
    (spec): spec is typeof spec & { entityType: (typeof PAGINATED)[number] } =>
      (PAGINATED as readonly string[]).includes(spec.entityType),
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
  // Metrics are computed from what ingestion just wrote, so the snapshot is
  // queued behind the plan rather than run on a timer that might fire first.
  await deps.snapshotQueue.add('compute', { workspaceId: data.workspaceId, repoId: data.repoId });
  return { planned: paginated.length, deferredToEnrich: specs.length - paginated.length };
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

    return processBackfillJob(
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
