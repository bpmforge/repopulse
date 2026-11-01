import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { auditLog, core, read, security, type Database } from '@repopulse/shared';
import { getScanner, isUpToDate, listScanners, type ScanProbe } from '@repopulse/security';
import { QUEUE, createQueue, createRedisConnection, type QueueName } from '@repopulse/ingest';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';
import { startableScannerKeys } from '../../lib/startable-scanners.js';
import { buildScanProbes } from './probes.js';

// Run it now (W16-10, F15).
//
// Everything this product does was scheduled and nothing could be started. The
// Security and Code Health tabs listed scanners that had "never run" with no
// button to run one, and Settings → Sync reported progress with no way to ask for
// any. For someone who installed RepoPulse ten minutes ago and wants to see it
// work, "wait until Sunday 02:41" is the wrong answer — and it is also how a
// first run looks identical to a broken install.
//
// TWO RULES SHAPE THIS FILE.
//
// It cannot double-start. Every enqueue carries a deterministic jobId, and
// BullMQ treats an add with an existing jobId as a no-op — so the second click
// is absorbed by the queue rather than by a flag in a route that a second API
// replica would not share. The response says which happened, because "already
// running" and "started" are different news.
//
// It cannot spend a budget it does not have (Law 7). A sync is forge API calls;
// if the budget is exhausted the request is REFUSED WITH THE RESET TIME rather
// than queued to fail later. A scan is local and has no forge budget, so it is
// not gated the same way — the asymmetry is deliberate, not an oversight.

export interface RunRoutesOptions {
  db: Database;
  redisUrl?: string | undefined;
  /** Injectable so tests exercise the route without Redis. */
  queueFor?: (queue: QueueName) => Queue | undefined;
  /**
   * W23-01. Per scanner key, what commit and tool versions a run would use —
   * the same probes the worker consults, so the route and the worker cannot
   * disagree about "up to date". Defaults to the real ones.
   */
  probes?: Record<string, ScanProbe>;
}

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  sendProblem(req, reply, status, title, detail === undefined ? {} : { detail });
  return reply;
}

/**
 * The window a manual run is deduplicated within.
 *
 * Deterministic rather than random so two clicks collapse, and coarse enough
 * that a double-click or an impatient second press is absorbed — but not so
 * coarse that someone who has actually fixed their configuration has to wait to
 * try again. Five minutes is about the length of "did that work?".
 */
export function runWindowKey(nowMs: number): string {
  return String(Math.floor(nowMs / (5 * 60_000)));
}

export default async function runRoutes(
  app: FastifyInstance,
  opts: RunRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const probes = opts.probes ?? buildScanProbes(db);
  const queues = new Map<string, Queue>();
  let connection: ReturnType<typeof createRedisConnection> | undefined;

  function queueFor(name: QueueName): Queue | undefined {
    if (opts.queueFor) return opts.queueFor(name);
    if (!opts.redisUrl) return undefined;
    let q = queues.get(name);
    if (!q) {
      connection ??= createRedisConnection(opts.redisUrl);
      q = createQueue(name, connection);
      queues.set(name, q);
    }
    return q;
  }

  app.addHook('onClose', async () => {
    for (const q of queues.values()) await q.close();
    await connection?.quit();
  });

  /** The repo, workspace-filtered — the tenancy invariant applies here too. */
  async function repoIn(workspaceId: number, id: number) {
    const [repo] = await db
      .select({
        id: core.repos.id,
        org: core.repos.org,
        name: core.repos.name,
        syncStatus: core.repos.syncStatus,
      })
      .from(core.repos)
      .where(and(eq(core.repos.id, id), eq(core.repos.workspaceId, workspaceId)))
      .limit(1);
    return repo ?? null;
  }

  /**
   * POST /repos/:id/scan — run the security and code-health scanners now.
   *
   * Admin-only: a scan is third-party code running over the customer's source,
   * and it costs real CPU on the host. That is not a per-user preference.
   */
  app.post<{ Params: { id: string }; Body: { scanner_key?: string; force?: boolean } }>(
    '/repos/:id/scan',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }

      const repoId = Number(request.params.id);
      if (!Number.isFinite(repoId)) return fail(request, reply, 400, 'Invalid repository id');

      const repo = await repoIn(workspaceId, repoId);
      if (!repo) return fail(request, reply, 404, 'No such repository');

      // ENABLEMENT IS DEFAULT-AWARE (W16-20) and ENABLED IS NOT THE SAME AS
      // STARTABLE (W16-28): an empty config means the catalogue defaults, and
      // only scanners with a `manual` trigger (a runner wired in the worker)
      // are offered. Shared with the first scan on going live (W20-22,
      // INS-60) so the two never disagree; lib/startable-scanners.ts.
      const enabledKeys = await startableScannerKeys(db, workspaceId, repoId);
      const startable = new Set(
        listScanners()
          .filter((s) => s.triggers.includes('manual'))
          .map((s) => s.key),
      );

      const requested = request.body?.scanner_key;
      // W23-01: "Full rescan". Strictly a boolean — a string "false" is truthy
      // and would silently force the most expensive path.
      const forceRaw = request.body?.force;
      if (forceRaw !== undefined && typeof forceRaw !== 'boolean') {
        return fail(request, reply, 400, 'Invalid request', '"force" must be true or false.');
      }
      const force = forceRaw === true;
      const keys = requested ? enabledKeys.filter((key) => key === requested) : enabledKeys;

      if (keys.length === 0) {
        return fail(
          request,
          reply,
          409,
          'Nothing to run',
          requested
            ? startable.has(requested)
              ? `The scanner "${requested}" is not enabled for this repository.`
              : `The scanner "${requested}" cannot be started on request — it runs on a schedule.`
            : 'No scanner is enabled for this repository — enable one first.',
        );
      }

      const queue = queueFor(QUEUE.securityScan);
      if (!queue) {
        return fail(
          request,
          reply,
          503,
          'The job queue is unavailable',
          'Redis is not reachable from the API, so nothing can be started right now.',
        );
      }

      const window = runWindowKey(Date.now());
      const started: string[] = [];
      const alreadyRunning: string[] = [];
      const upToDate: string[] = [];

      // W23-01 (WP-X9): which of these would be answered by an earlier run,
      // asked SYNCHRONOUSLY so the person is told on the press rather than
      // after a poll. Same probe and same isUpToDate as the worker's check. A
      // forced press skips the question; a probe that cannot say counts as "not
      // up to date" — the scan runs.
      const answered = new Set<string>();
      if (!force) {
        for (const key of keys) {
          const probe = probes[key];
          if (!probe) continue;
          try {
            const probed = await probe({ workspaceId, repoId });
            if (!probed) continue;
            const match = await isUpToDate(db, {
              workspaceId,
              repoId,
              scannerKey: key,
              commitSha: probed.commitSha,
              toolVersions: probed.toolVersions ?? null,
              dataVersion:
                probed.dataVersion !== undefined
                  ? probed.dataVersion
                  : ((await getScanner(key)?.dataVersion?.()) ?? null),
            });
            if (match) answered.add(key);
          } catch (err) {
            request.log.warn({ err, key }, 'up-to-date probe failed; the scan will run');
          }
        }
      }

      // W23-02 (WP-R2): ONE batch job for the whole press. The worker resolves
      // the head once, asks "up to date?" per scanner and fetches ONE archive
      // for every snapshot scanner that remains — instead of N jobs, N tarballs
      // of the same commit.
      //
      // A forced press gets its own id: sharing one with a non-forced press in
      // the same window would make BullMQ drop the "Full rescan" as a duplicate
      // of a job that is about to skip. A single-scanner press (`scanner_key`)
      // carries its key, so it is not swallowed by an all-scanners job in the
      // same window either.
      const jobId = `sec-batch-${repoId}-${requested ? `${requested}-` : ''}${force ? 'force-' : ''}${window}`;
      // ASKED BEFORE ADDING, not inferred from the add. BullMQ's `add` returns
      // the existing job when the id is taken, and that job is indistinguishable
      // from a freshly created one, so there is nothing in the return value to
      // tell the two apart (the first version reported every second press as a
      // fresh start — the exact lie the response exists to avoid).
      const taken = await queue.getJob(jobId);
      let running = false;
      if (taken) {
        // "Already running" has to mean RUNNING. A job that finished inside the
        // window still holds its id (BullMQ keeps completed and failed records),
        // and the W17-30 journey found what that does: the CVE scan fails in
        // 30 ms for want of a database, the operator runs scan-db-sync and
        // presses again, and for the rest of five minutes the answer is
        // "already running" about a job that is over. The window is for
        // double-presses, not for punishing the fix.
        const state = await taken.getState();
        if (state === 'completed' || state === 'failed') {
          await taken.remove();
        } else {
          running = true;
        }
      }

      if (running) {
        alreadyRunning.push(...keys);
      } else {
        await queue.add(
          'manual',
          {
            workspaceId,
            repoId,
            // The keys are in `scannerKeys`; the job is about the repository.
            scannerKey: '',
            scannerKeys: keys,
            commitSha: '',
            trigger: 'manual' as const,
            mode: 'batch' as const,
            // W16-18. The id of the request that started this job, and who
            // pressed the button. job_failure stores the whole payload as jsonb,
            // so both land in the dead-letter ledger with no migration — and
            // "I pressed Run scans and nothing happened" becomes a row someone
            // can actually find. Without it a failed job is anonymous: the
            // queue knows what ran, and nothing knows who asked.
            requestId: request.id,
            requestedBy: userId,
            ...(force ? { force: true } : {}),
          },
          { jobId },
        );
        // Still enqueued when up to date: the worker records the `skipped` row
        // (cheap — no tarball) so the coverage table reads "up to date as of
        // today". Reported apart from `started`, which means "will really scan".
        for (const key of keys) {
          if (answered.has(key)) upToDate.push(key);
          else started.push(key);
        }
      }

      auditLog(request.log, {
        event: 'scan.manual_run',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: {
          repo: `${repo.org}/${repo.name}`,
          started,
          already_running: alreadyRunning,
          up_to_date: upToDate,
          force,
        },
      });

      return reply.code(202).send({
        started,
        already_running: alreadyRunning,
        up_to_date: upToDate,
        repo: `${repo.org}/${repo.name}`,
      });
    },
  );

  /**
   * POST /repos/:id/sync — pull new forge data for this repository now.
   *
   * Gated on the rate-limit budget (Law 7). Queueing a job that will fail on a
   * spent budget is worse than refusing: the refusal can name the reset time,
   * and a failure in an hour cannot be traced back to this click.
   */
  app.post<{ Params: { id: string } }>(
    '/repos/:id/sync',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }

      const repoId = Number(request.params.id);
      if (!Number.isFinite(repoId)) return fail(request, reply, 400, 'Invalid repository id');

      const repo = await repoIn(workspaceId, repoId);
      if (!repo) return fail(request, reply, 404, 'No such repository');

      // The budget is a RUNTIME gauge in the forge client, not a warehoused
      // number, so there is nothing here to read a remaining-call count from.
      // What IS warehoused is the conclusion: the ingester parks a repository in
      // `paused_budget` when it runs out. That is the product's own record of
      // "no forge calls left", so it is what this gate reads (Law 7).
      if (repo.syncStatus === 'paused_budget') {
        return fail(
          request,
          reply,
          429,
          'The forge rate-limit budget is spent',
          'Ingestion for this repository is paused until the forge rate-limit window resets. Starting a sync now would queue a job that could only fail.',
        );
      }

      const queue = queueFor(QUEUE.delta);
      if (!queue) {
        return fail(
          request,
          reply,
          503,
          'The job queue is unavailable',
          'Redis is not reachable from the API, so nothing can be started right now.',
        );
      }

      const jobId = `delta-manual-${repoId}-${runWindowKey(Date.now())}`;
      const started = (await queue.getJob(jobId)) === undefined;
      if (started) {
        await queue.add(
          'manual',
          { workspaceId, repoId, trigger: 'manual', requestId: request.id, requestedBy: userId },
          { jobId },
        );
      }

      auditLog(request.log, {
        event: 'sync.manual_run',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: { repo: `${repo.org}/${repo.name}`, started },
      });

      return reply.code(202).send({ started, repo: `${repo.org}/${repo.name}` });
    },
  );

  /**
   * GET /repos/:id/scan-runs?since=ISO — what each scan run since a moment
   * reported (W20-21, UX_TODO FND-68).
   *
   * "Run scans now" used to end with "the table above is current", which left
   * the person who pressed it — usually to check a fix — to compare counts by
   * memory. Per run: what the scanner reported, how many findings are new
   * (first raised by this run) and how many earlier findings it closed, so the
   * button can link straight to each set in Findings. Any member may read it:
   * it is the same data the Coverage table and Findings already show them.
   */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/repos/:id/scan-runs',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.id);
      if (!Number.isFinite(repoId)) return fail(request, reply, 400, 'Invalid repository id');
      const since = request.query.since ? new Date(request.query.since) : null;
      if (!since || Number.isNaN(since.getTime())) {
        return fail(request, reply, 400, 'Invalid since', 'Pass `since` as an ISO date-time.');
      }
      const repo = await repoIn(workspaceId, repoId);
      if (!repo) return fail(request, reply, 404, 'No such repository');

      const runs = await db
        .select({
          id: security.scanRuns.id,
          scannerKey: security.scanRuns.scannerKey,
          status: security.scanRuns.status,
          scope: security.scanRuns.scope,
          partial: security.scanRuns.partial,
          findingCount: security.scanRuns.findingCount,
          commitSha: security.scanRuns.commitSha,
          error: security.scanRuns.error,
          startedAt: security.scanRuns.startedAt,
          finishedAt: security.scanRuns.finishedAt,
        })
        .from(security.scanRuns)
        .where(
          and(
            eq(security.scanRuns.workspaceId, workspaceId),
            eq(security.scanRuns.repoId, repoId),
            gte(security.scanRuns.startedAt, since),
          ),
        )
        .orderBy(desc(security.scanRuns.startedAt))
        .limit(50);
      const ids = runs.map((r) => r.id);

      const created = ids.length
        ? await db
            .select({ runId: read.findings.scanRunId, n: sql<number>`count(*)::int` })
            .from(read.findings)
            .where(
              and(
                eq(read.findings.workspaceId, workspaceId),
                inArray(read.findings.scanRunId, ids),
              ),
            )
            .groupBy(read.findings.scanRunId)
        : [];
      const closed = ids.length
        ? await db
            .select({
              runId: read.findingEvents.scanRunId,
              n: sql<number>`count(distinct ${read.findingEvents.findingId})::int`,
            })
            .from(read.findingEvents)
            .where(
              and(
                eq(read.findingEvents.workspaceId, workspaceId),
                inArray(read.findingEvents.scanRunId, ids),
                eq(read.findingEvents.toStatus, 'resolved'),
              ),
            )
            .groupBy(read.findingEvents.scanRunId)
        : [];
      const newBy = new Map(created.map((r) => [r.runId, r.n]));
      const closedBy = new Map(closed.map((r) => [r.runId, r.n]));

      return reply.send({
        repo_id: repoId,
        since: since.toISOString(),
        runs: runs.map((r) => ({
          id: r.id,
          scanner_key: r.scannerKey,
          status: r.status,
          scope: r.scope,
          partial: r.partial,
          finding_count: r.findingCount,
          new_count: newBy.get(r.id) ?? 0,
          closed_count: closedBy.get(r.id) ?? 0,
          commit_sha: r.commitSha,
          error: r.error,
          started_at: r.startedAt.toISOString(),
          finished_at: r.finishedAt?.toISOString() ?? null,
        })),
      });
    },
  );
}
