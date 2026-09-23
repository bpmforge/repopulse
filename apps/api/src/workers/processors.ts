import type { Job, Queue } from 'bullmq';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { core, read } from '@repopulse/shared';
import { readWorkspaceSettings } from '../lib/workspace-settings.js';
import {
  addReplacingFinished,
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
  repoSyncStatus,
  PAGINATED_ENTITIES,
  readCursor,
  type BackfillJobData,
  type DeltaJobData,
  type SyncStreamEvent,
} from '@repopulse/ingest';
import { computeRepoSnapshots } from '@repopulse/metrics';
import { hotspotPercentiles, repriceFindings, writeFindingsMetric } from '@repopulse/insights';
import { providerForRepo, type WorkerProviderDeps } from './forge-provider.js';

// The queue processors (W12-03).
//
// These functions were all built and unit-tested in W2/W3 and then never
// registered, so the worker consumed nothing and the warehouse was only ever
// populated by the seeder. This module is the missing wiring, kept separate
// from the entrypoint so it can be tested without booting a worker.

export interface SecretsStreamRequest {
  workspaceId: number;
  repoId: number;
  repo: string;
  provider: unknown;
  trigger: 'pr_synced' | 'push';
}

export interface ProcessorDeps extends WorkerProviderDeps {
  /**
   * Secrets stream scan, injected by the worker entrypoint (W8-04).
   *
   * Optional so processor tests stay free of the security package — but its
   * ABSENCE in production would be the same defect this module was written to
   * close, so workers/index.ts wires it and a test asserts the delta path
   * calls it.
   */
  runSecretsStream?: (req: SecretsStreamRequest) => Promise<{
    findingsCreated: number;
    scanned: unknown[];
    deferred: number;
    skipped?: string;
  }>;
  /** Re-enqueue onto the backfill queue (continuations and planned entities). */
  backfillQueue: Queue;
  snapshotQueue: Queue;
  /** Per-commit churn fan-out (W12-05). */
  enrichQueue: Queue;
  /** Nightly sweep fan-out (W12-05). */
  reconcileQueue: Queue;
  /**
   * Publish a sync event to the workspace's channel (W4-22). Optional and
   * injectable so processors stay testable without Redis — but its ABSENCE in
   * production is the defect this ticket exists to close: publishSyncEvent had
   * zero callers, so the SSE endpoint W4-18 mounted relayed a channel nobody
   * ever wrote to and live sync had never worked.
   */
  publish?: (workspaceId: number, event: SyncStreamEvent) => Promise<void>;
}

/**
 * Publish a repo's CURRENT status, read from the same function the GET status
 * endpoint uses so the pushed pct and the polled pct can never disagree —
 * API_DESIGN §3 makes SSE an optimization over those reads, which only holds if
 * both report the same number.
 *
 * Never throws. A dropped event means a slightly staler dashboard (the design
 * says so explicitly); failing an ingestion job because a pub/sub write failed
 * would trade a cosmetic problem for a data one.
 */
async function emitSyncStatus(
  deps: ProcessorDeps,
  workspaceId: number,
  repoId: number,
  type: 'sync.progress' | 'sync.done',
): Promise<void> {
  if (!deps.publish) return;
  try {
    const status = await repoSyncStatus(deps.db, repoId);
    if (!status) return;
    await deps.publish(workspaceId, {
      type,
      data: { repoId, phase: status.phase, pct: status.percentComplete },
    });
  } catch {
    /* best-effort by design (API_DESIGN §3) */
  }
}

async function emitBudgetWarning(
  deps: ProcessorDeps,
  workspaceId: number,
  repoId: number,
): Promise<void> {
  if (!deps.publish) return;
  try {
    await deps.publish(workspaceId, {
      type: 'budget.warning',
      data: {
        repoId,
        message: `Sync paused for repo ${repoId} — forge rate-limit budget floor reached`,
      },
    });
  } catch {
    /* best-effort by design */
  }
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

  let enqueued = 0;
  for (const spec of paginated) {
    // A re-plan (the nightly sweep rescuing an `error` repo, W17-41) must not
    // re-walk history that already finished — that is forge budget spent to
    // learn nothing — and must resume an unfinished entity from its checkpoint
    // rather than from page one.
    const cursor = await readCursor(deps.db, spec.repoId, spec.entityType);
    if (cursor?.backfillDone) continue;
    // jobId comes from the planner so a re-planned repo collapses onto a job
    // still in flight instead of duplicating it; a FINISHED job under that id
    // is replaced, or the re-plan would be silently absorbed by it.
    await addReplacingFinished(
      deps.backfillQueue,
      spec.entityType,
      {
        workspaceId: data.workspaceId,
        repoId: spec.repoId,
        repo: resolved.repoFullName,
        entityType: spec.entityType,
        since: spec.since,
        ...(cursor?.cursorValue ? { cursor: cursor.cursorValue } : {}),
      } satisfies BackfillJobData,
      { jobId: spec.jobId },
    );
    enqueued++;
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

  // Nothing left to walk: no entity job will finish to trigger the enrichment
  // fan-out, so do it here. This is the path a repo rescued from a dead-lettered
  // enrich job takes (W17-41).
  if (enqueued === 0 && (await isHistoryBackfillComplete(deps.db, data.repoId))) {
    await startEnrichment(deps, data.workspaceId, data.repoId);
  }

  return { planned: enqueued, deferredToEnrich: specs.length - paginated.length };
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
  await startEnrichment(deps, data.workspaceId, data.repoId);
  return true;
}

/**
 * Fan out enrichment; if there was nothing to enrich, finish the repo now.
 *
 * The live flip used to happen only at the end of an enrich job, so a repo
 * with no commit or PR awaiting enrichment — an empty repo, or one whose last
 * pending item was the dead-lettered job's — had no job left to flip it and
 * sat in `backfilling` forever (W17-41).
 */
async function startEnrichment(
  deps: ProcessorDeps,
  workspaceId: number,
  repoId: number,
): Promise<void> {
  const fanned = await fanOutEnrichment(deps, workspaceId, repoId);
  if (fanned.commits + fanned.prs > 0) return;
  if (await goLiveIfEnriched(deps, workspaceId, repoId)) {
    await emitSyncStatus(deps, workspaceId, repoId, 'sync.done');
  }
}

/**
 * enrichment --> live (§2: "enrichment queue drained"). Guarded on the current
 * value for the same reason processPlan is: many churn jobs finish
 * concurrently and all observe drained, so the losers must no-op rather than
 * throw an illegal transition into the DLQ. Returns true only for the caller
 * whose UPDATE actually flipped the repo.
 */
async function goLiveIfEnriched(
  deps: ProcessorDeps,
  workspaceId: number,
  repoId: number,
): Promise<boolean> {
  if (!(await isFullyEnriched(deps, repoId))) return false;
  const live = syncPhaseToRepoStatus(nextPhase('enrichment', 'enrichment_complete'));
  const updated = await deps.db
    .update(core.repos)
    .set({ syncStatus: live })
    .where(and(eq(core.repos.id, repoId), eq(core.repos.syncStatus, 'backfilling')))
    .returning({ id: core.repos.id });
  if (updated.length === 0) return false;
  // Recompute now that churn exists: the snapshot taken when history finished
  // could not see any file-level data yet. Replacing a finished job of the same
  // key: a repo that recovers from a stall on the day it first went live must
  // still get its recompute.
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await addReplacingFinished(
    deps.snapshotQueue,
    'compute',
    { workspaceId, repoId },
    { jobId: `${jobId.snapshot(repoId, yyyymmdd)}-enriched` },
  );
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
  const commits = await commitsNeedingChurn(deps.db, repoId, ENRICH_FAN_OUT_LIMIT);
  for (const commit of commits) {
    // jobId.enrich is the §6 idempotency key: re-planning a repo, or two entity
    // jobs both completing the history, collapse onto the same jobs instead of
    // re-fetching every commit's files.
    // A finished job under the key is replaced (W17-41): a commit still in this
    // list after its job completed or dead-lettered has not been handled.
    await addReplacingFinished(
      deps.enrichQueue,
      'commitFiles',
      { workspaceId, repoId, sha: commit.sha },
      { jobId: jobId.enrich(repoId, commit.sha) },
    );
  }

  const prs = await prsNeedingEnrichment(deps.db, repoId, ENRICH_FAN_OUT_LIMIT);
  for (const pr of prs) {
    // Keyed on the PR number rather than a SHA so it stays distinct from the
    // churn job for the same head commit.
    await addReplacingFinished(
      deps.enrichQueue,
      'prDetail',
      { workspaceId, repoId, prNumber: pr.number, headSha: pr.headSha },
      { jobId: `${jobId.enrich(repoId, String(pr.number))}-pr` },
    );
  }

  // A full batch means more may be waiting. The fan-out is capped so one round
  // cannot flood the queue, but nothing ever asked for the NEXT round: a repo
  // with more than one batch of commits or PRs drained the first and sat in
  // `backfilling` forever (W17-41). A `fanOut` job queued behind the batch —
  // same queue, same priority, so BullMQ runs it after the batch's jobs are
  // picked up — asks again. No jobId: two concurrent fan-outs queueing two
  // continuations costs one idempotent extra round, nothing more.
  if (commits.length === ENRICH_FAN_OUT_LIMIT || prs.length === ENRICH_FAN_OUT_LIMIT) {
    await deps.enrichQueue.add('fanOut', { workspaceId, repoId });
  }

  return { commits: commits.length, prs: prs.length };
}

/** One enrichment round per repo (commitsNeedingChurn / prsNeedingEnrichment cap). */
const ENRICH_FAN_OUT_LIMIT = 500;

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
          // A budget park is the one status change a user must be told about
          // rather than left to discover: the dashboard simply stops advancing,
          // which is indistinguishable from a stalled worker (NFR-12).
          if (status === 'paused_budget') {
            await emitBudgetWarning(deps, data.workspaceId, repoId);
          }
        },
      },
      data,
    );

    // Only a finished entity can complete the repo. A continuation (more pages)
    // or a budget park is explicitly not done, and asking on every page would
    // be a needless query per page.
    const snapshotQueued = result.done === true ? await maybeSnapshot(deps, data) : false;
    // Progress after every entity job, including continuations: recent-first
    // backfill means the useful window fills early, so a page that advances
    // coverage is exactly what the org sync banner exists to show.
    await emitSyncStatus(deps, data.workspaceId, data.repoId, 'sync.progress');
    return { ...result, ...(snapshotQueued ? { snapshotQueued: true } : {}) };
  };
}

/** Webhook deltas — accepted by the receiver since W2-04 and never applied until now. */
export function deltaProcessor(deps: ProcessorDeps) {
  return async (job: Job) => {
    const data = job.data as DeltaJobData;
    const resolved = await providerForRepo(deps, data.workspaceId, data.repoId);
    if (!resolved) return { skipped: 'no active connection' };
    const result = await processDeltaJob({ db: deps.db, provider: resolved.provider }, data);

    // Secrets stream mode (W8-04, FR-SEC-3). It rides the delta rather than
    // taking a queue hop, because the whole claim of stream mode is "a finding
    // within 60s of the webhook" — and it runs AFTER the delta, because it
    // scans head SHAs the delta has just warehoused.
    //
    // Injected rather than imported here so the scanner is a decision the
    // worker makes, not a dependency of ingestion.
    let secrets: Awaited<ReturnType<NonNullable<ProcessorDeps['runSecretsStream']>>> | undefined;
    if (deps.runSecretsStream && (data.kind === 'pull_requests' || data.kind === 'push_commits')) {
      secrets = await deps.runSecretsStream({
        workspaceId: data.workspaceId,
        repoId: data.repoId,
        repo: resolved.repoFullName,
        provider: resolved.provider,
        trigger: data.kind === 'push_commits' ? 'push' : 'pr_synced',
      });
    }
    // A webhook delta is the ONLY path that changes a live repo's data, so
    // without this a live dashboard never updates until someone reloads —
    // NFR-10 asks for webhook→dashboard within 60s.
    await emitSyncStatus(deps, data.workspaceId, data.repoId, 'sync.progress');
    return { ...result, ...(secrets ? { secrets } : {}) };
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
    if (job.name === 'fanOut') return continueFanOut(deps, data.workspaceId, data.repoId);

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

    const becameLive = await goLiveIfEnriched(deps, data.workspaceId, data.repoId);
    // `sync.done` fires exactly once per repo, on the guarded UPDATE that
    // actually flipped it live — the concurrent losers return 0 rows, so the
    // client gets one "finished syncing" toast rather than one per churn job.
    if (becameLive) await emitSyncStatus(deps, data.workspaceId, data.repoId, 'sync.done');
    return { ...outcome, ...(becameLive ? { becameLive: true } : {}) };
  };
}

/**
 * The next enrichment round for a repo whose last round was a full batch.
 * Only while the repo is still backfilling: a repo moved to `error` by a dead
 * letter waits for the nightly sweep, and a live one has nothing to finish.
 */
async function continueFanOut(deps: ProcessorDeps, workspaceId: number, repoId: number) {
  const [repo] = await deps.db
    .select({ syncStatus: core.repos.syncStatus })
    .from(core.repos)
    .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
    .limit(1);
  if (repo?.syncStatus !== 'backfilling')
    return { skipped: `repo is ${repo?.syncStatus ?? 'gone'}` };
  await startEnrichment(deps, workspaceId, repoId);
  return { fannedOut: true };
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
    // W9-09: reprice AFTER the snapshot, in the same job, because the hotspot
    // percentiles the pricer reads are the ones this snapshot just wrote. A
    // separate nightly job would race the write it depends on, and the failure
    // would be a scoreboard that lags a day behind its own inputs.
    const hotspots = await hotspotPercentiles(deps.db, data.workspaceId, data.repoId);
    const ruleFpRates = await ruleFpRatesFor(deps.db, data.workspaceId);
    const repriced = await repriceFindings({
      db: deps.db,
      workspaceId: data.workspaceId,
      repoId: data.repoId,
      hotspots,
      ruleFpRates,
    });

    // W10-05: the FINDINGS row, LAST — it summarises effective_risk, so a
    // version that ran before the reprice would publish yesterday's risk under
    // today's timestamp. Every finding-sourced plan-catalog entry reads this
    // row; until it existed they were all inert in production.
    const findingsMetric = await writeFindingsMetric(deps.db, data.workspaceId, data.repoId);

    return {
      written,
      repriced: repriced.priced,
      bandChanges: repriced.bandChanges.length,
      findingsSummarised: findingsMetric.dims.openCount,
    };
  };
}

/**
 * Per-rule false-positive rates, the pricer's precision prior (W9-07 stats).
 *
 * Computed once per repo pass rather than per finding: it is one grouped query
 * against dispositions, and doing it inside the loop would issue one per row.
 */
async function ruleFpRatesFor(
  db: ProcessorDeps['db'],
  workspaceId: number,
): Promise<Map<string, number | null>> {
  const rows = await db
    .select({
      ruleId: read.findings.ruleId,
      triaged: sql<number>`count(*) filter (where ${read.findings.status} in ('confirmed','dismissed','resolved','wont_fix'))::int`,
      fp: sql<number>`count(*) filter (where ${read.findings.status} = 'dismissed' and ${read.findings.dismissReason} = 'false_positive')::int`,
    })
    .from(read.findings)
    .where(and(eq(read.findings.workspaceId, workspaceId), isNotNull(read.findings.ruleId)))
    .groupBy(read.findings.ruleId);

  const out = new Map<string, number | null>();
  for (const row of rows) {
    if (!row.ruleId) continue;
    // null over an untriaged rule, never 0 — the pricer treats null as "no
    // stats" (0.7) rather than as a perfect rule.
    out.set(row.ruleId, row.triaged === 0 ? null : row.fp / row.triaged);
  }
  return out;
}
