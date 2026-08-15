import type { Job, Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import { readWorkspaceSettings } from '../lib/workspace-settings.js';
import {
  commitsNeedingChurn,
  enrichCommitChurn,
  enrichPullRequest,
  isEnrichmentDrained,
  isPrEnrichmentDrained,
  prsNeedingEnrichment,
  isHistoryBackfillComplete,
  jobId,
  nextPhase,
  planBackfill,
  processBackfillJob,
  processDeltaJob,
  reconcileRepo,
  requeueErrorRepos,
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
  /** Per-commit churn fan-out (W12-05). */
  enrichQueue: Queue;
  /** Nightly sweep fan-out (W12-05). */
  reconcileQueue: Queue;
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
  // History is done, so the enrichment phase can start: fan out per-commit
  // churn. Nothing enqueued enrich work before this, which is why the queue had
  // no consumer AND no producer — registering a processor alone would have
  // been a consumer for a queue nothing feeds.
  await fanOutEnrichment(deps, data.workspaceId, data.repoId);
  return true;
}

/**
 * Fan out the enrichment phase: per-commit file churn AND per-PR reviews/checks.
 *
 * Enrichment covers every per-parent detail fetch (founder decision,
 * 2026-08-13), not just churn. All three are nested fetches keyed on a row the
 * history phase already ingested, which is what separates them from the
 * paginated entities walked at repo scope.
 */
async function fanOutEnrichment(
  deps: ProcessorDeps,
  workspaceId: number,
  repoId: number,
): Promise<{ commits: number; prs: number }> {
  const commits = await commitsNeedingChurn(deps.db, repoId);
  for (const commit of commits) {
    // jobId.enrich is the §6 idempotency key: re-planning a repo, or two entity
    // jobs both completing the history, collapse onto the same jobs instead of
    // re-fetching every commit's files.
    await deps.enrichQueue.add(
      'commitFiles',
      { workspaceId, repoId, sha: commit.sha },
      { jobId: jobId.enrich(repoId, commit.sha) },
    );
  }

  const prs = await prsNeedingEnrichment(deps.db, repoId);
  for (const pr of prs) {
    // Keyed on the PR number rather than a SHA so it stays distinct from the
    // churn job for the same head commit.
    await deps.enrichQueue.add(
      'prDetail',
      { workspaceId, repoId, prNumber: pr.number, headSha: pr.headSha },
      { jobId: `${jobId.enrich(repoId, String(pr.number))}-pr` },
    );
  }

  return { commits: commits.length, prs: prs.length };
}

/**
 * Both halves of enrichment must be drained before `live` (§2). Checking only
 * churn would flip the repo live with reviews and checks still missing — the
 * screens would render an empty reviews section on a repo reporting itself
 * fully synced.
 */
async function isFullyEnriched(deps: ProcessorDeps, repoId: number): Promise<boolean> {
  return (
    (await isEnrichmentDrained(deps.db, repoId)) && (await isPrEnrichmentDrained(deps.db, repoId))
  );
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

/**
 * Enrichment (W12-05): per-commit file churn, the §6 `commitFiles {repoId, sha}`
 * payload. This is what hotspot/ownership/churn metrics read — M1 and M2 stay
 * at zero without it, which is exactly how the first ingested repo presented.
 *
 * Scope note: enrichment is file churn and nothing else. §2 defines it that
 * way and §6's payload says so; checks are a HISTORY-phase entity (§3) and
 * reviews have no lane in the design at all (open question, W12-05 notes).
 */
export function enrichProcessor(deps: ProcessorDeps) {
  return async (job: Job) => {
    const data = job.data as {
      workspaceId: number;
      repoId: number;
      sha?: string;
      prNumber?: number;
      headSha?: string;
    };
    const resolved = await providerForRepo(deps, data.workspaceId, data.repoId);
    if (!resolved) return { skipped: 'no active connection' };

    const outcome =
      job.name === 'prDetail'
        ? await enrichPullRequest(
            { db: deps.db, provider: resolved.provider },
            {
              workspaceId: data.workspaceId,
              repoId: data.repoId,
              repo: resolved.repoFullName,
              prNumber: data.prNumber!,
              headSha: data.headSha!,
            },
          )
        : {
            files: await enrichCommitChurn(
              { db: deps.db, provider: resolved.provider },
              {
                workspaceId: data.workspaceId,
                repoId: data.repoId,
                repo: resolved.repoFullName,
                sha: data.sha!,
              },
            ),
          };

    // enrichment --> live (§2: "enrichment queue drained"). Guarded on the
    // current value for the same reason processPlan is: many churn jobs finish
    // concurrently and all observe drained, so the losers must no-op rather
    // than throw an illegal transition into the DLQ.
    let becameLive = false;
    if (await isFullyEnriched(deps, data.repoId)) {
      const live = syncPhaseToRepoStatus(nextPhase('enrichment', 'enrichment_complete'));
      const updated = await deps.db
        .update(core.repos)
        .set({ syncStatus: live })
        .where(and(eq(core.repos.id, data.repoId), eq(core.repos.syncStatus, 'backfilling')))
        .returning({ id: core.repos.id });
      becameLive = updated.length > 0;
      if (becameLive) {
        // Recompute now that churn exists: the snapshot taken when history
        // finished could not see any file-level data yet.
        const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        await deps.snapshotQueue.add(
          'compute',
          { workspaceId: data.workspaceId, repoId: data.repoId },
          { jobId: `${jobId.snapshot(data.repoId, yyyymmdd)}-enriched` },
        );
      }
    }
    return { ...outcome, ...(becameLive ? { becameLive: true } : {}) };
  };
}

/**
 * Reconcile (W12-05): the nightly sweep. Two job kinds, mirroring the backfill
 * queue's plan/entity split — a `sweep` that decides the work and per-repo jobs
 * that do it. §6 specifies a nightly cron keyed rc:{repoId}:{yyyymmdd}.
 */
export function reconcileProcessor(deps: ProcessorDeps) {
  return async (job: Job) => {
    if (job.name === 'sweep') return processReconcileSweep(deps);

    const data = job.data as { workspaceId: number; repoId: number };
    const resolved = await providerForRepo(deps, data.workspaceId, data.repoId);
    if (!resolved) return { skipped: 'no active connection' };
    const counts = await reconcileRepo(
      { db: deps.db, provider: resolved.provider },
      { workspaceId: data.workspaceId, repoId: data.repoId, repo: resolved.repoFullName },
    );
    return { counts };
  };
}

/** The nightly fan-out: rescue stuck repos, then sweep the live ones. */
async function processReconcileSweep(deps: ProcessorDeps) {
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const workspaces = await deps.db.select({ id: core.workspaces.id }).from(core.workspaces);

  let requeued = 0;
  let swept = 0;
  for (const ws of workspaces) {
    // Repos stuck in `error` get a fresh plan (§5). requeueErrorRepos was
    // implemented in W2 and had no caller until now.
    const ids = await requeueErrorRepos(
      {
        db: deps.db,
        enqueuePlan: async ({ workspaceId, repoId }) => {
          await deps.backfillQueue.add('plan', { workspaceId, repoId });
        },
      },
      ws.id,
    );
    requeued += ids.length;

    // Then sweep everything already serving data, repairing gaps a missed
    // webhook left behind.
    const live = await deps.db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.workspaceId, ws.id), eq(core.repos.syncStatus, 'live')));
    for (const repo of live) {
      await deps.reconcileQueue.add(
        'repo',
        { workspaceId: ws.id, repoId: repo.id },
        { jobId: jobId.reconcile(repo.id, yyyymmdd) },
      );
      swept++;
    }
  }
  return { requeued, swept };
}

/** Metric snapshots — the numbers every screen reads. */
export function snapshotProcessor(deps: ProcessorDeps) {
  return async (job: Job) => {
    const data = job.data as { workspaceId: number; repoId: number };
    // W4-09. This used to pass a literal `botGlobs: []`, which is NOT "use the
    // defaults": isBotLogin does `globs.some(...)`, so an empty list means
    // nothing is a bot and METRICS.md §0's shared exclusion rule had never held
    // for a single number computed from real ingestion. The settings reader
    // returns DEFAULT_BOT_LOGIN_GLOBS when an admin has not chosen a list, and
    // an empty array only when one deliberately did.
    const { effective } = await readWorkspaceSettings(deps.db, data.workspaceId);
    const written = await computeRepoSnapshots(deps.db, {
      workspaceId: data.workspaceId,
      repoId: data.repoId,
      asOf: new Date(),
      botGlobs: effective.botLoginGlobs,
      staleThresholdDays: effective.stalePrDays,
    });
    return { written };
  };
}
