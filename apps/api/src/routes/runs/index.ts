import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { auditLog, core, security, type Database } from '@repopulse/shared';
import { SCANNER_DEFAULTS, isEnabled, listScanners } from '@repopulse/security';
import { QUEUE, createQueue, createRedisConnection, type QueueName } from '@repopulse/ingest';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';

// Run it now (W16-10, F15).
//
// Everything this product does was scheduled and nothing could be started. The
// Security and Code Health tabs listed scanners that had "never run" with no
// button to run one, and Admin → Sync reported progress with no way to ask for
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
  app.post<{ Params: { id: string }; Body: { scanner_key?: string } }>(
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

      // ENABLEMENT IS DEFAULT-AWARE (W16-20).
      //
      // The first version selected rows from repo_scanner_config and treated an
      // empty result as "nothing enabled". But `isEnabled` falls back to
      // SCANNER_DEFAULTS when there is NO row, which is the state of every
      // repository on a fresh install — so the coverage table read "enabled"
      // for four scanners while this button answered "Nothing to run" directly
      // beneath it. The feature was dead for every repository nobody had
      // explicitly toggled.
      //
      // Reading through the same helper the coverage table uses is what keeps
      // the two from disagreeing again.
      const stored = await db
        .select({
          key: security.repoScannerConfig.scannerKey,
          enabled: security.repoScannerConfig.enabled,
        })
        .from(security.repoScannerConfig)
        .where(eq(security.repoScannerConfig.repoId, repoId));
      const byKey = new Map(stored.map((row) => [row.key, row]));

      const catalogue = [
        ...new Set([...listScanners().map((s) => s.key), ...SCANNER_DEFAULTS.map((d) => d.key)]),
      ];
      const enabledKeys = catalogue.filter((key) => isEnabled(key, byKey.get(key)));

      const requested = request.body?.scanner_key;
      const keys = requested
        ? enabledKeys.filter((key) => key === requested)
        : enabledKeys;

      if (keys.length === 0) {
        return fail(
          request,
          reply,
          409,
          'Nothing to run',
          requested
            ? `The scanner "${requested}" is not enabled for this repository.`
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

      for (const key of keys) {
        const jobId = `sec-manual-${repoId}-${key}-${window}`;
        // ASKED BEFORE ADDING, not inferred from the add. BullMQ's `add`
        // returns the existing job when the id is taken, and that job is
        // indistinguishable from a freshly created one — same id, same shape —
        // so there is nothing in the return value to tell the two apart. The
        // first version of this tried and reported every second press as a
        // fresh start, which is the exact lie the response exists to avoid.
        if (await queue.getJob(jobId)) {
          alreadyRunning.push(key);
          continue;
        }

        await queue.add(
          'manual',
          {
            workspaceId,
            repoId,
            scannerKey: key,
            commitSha: '',
            trigger: 'manual' as const,
            mode: 'history' as const,
            // W16-18. The id of the request that started this job, and who
            // pressed the button. job_failure stores the whole payload as jsonb,
            // so both land in the dead-letter ledger with no migration — and
            // "I pressed Run scans and nothing happened" becomes a row someone
            // can actually find. Without it a failed job is anonymous: the
            // queue knows what ran, and nothing knows who asked.
            requestId: request.id,
            requestedBy: userId,
          },
          { jobId },
        );
        started.push(key);
      }

      auditLog(request.log, {
        event: 'scan.manual_run',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: { repo: `${repo.org}/${repo.name}`, started, already_running: alreadyRunning },
      });

      return reply.code(202).send({
        started,
        already_running: alreadyRunning,
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
}
