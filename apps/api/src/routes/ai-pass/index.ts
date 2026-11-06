import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  auditLog,
  core,
  facts,
  isConstraintViolation,
  read,
  type Database,
} from '@repopulse/shared';
import { QUEUE, createQueue, createRedisConnection, type QueueName } from '@repopulse/ingest';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';
import { AI_PASS_MAX_PATHS } from '../../workers/ai-pass-processor.js';
import { aiPauseState, refuseWhenAiPaused } from '../../lib/ai-pause.js';
import { SECOND_OPINION_SENDS, secondOpinionOptions } from '../../lib/ai-second-opinion.js';
import scheduleRoutes from './schedule.js';

// The AI pass: start one, watch it, and read what it suggested (W19-09).
//
//   POST /repos/:id/ai-pass                 admin - queues a pass over named paths
//   GET  /repos/:id/ai-pass                 the repository's recent passes
//   GET  /findings/:id/ai                   how the finding was raised, and its AI suggestions
//   POST /findings/:id/ai-verdicts/:v/decide  a person accepts or dismisses a SUGGESTION
//   POST /findings/:id/ai-verdicts/:v/second-opinion  admin - ask another model (W20-18)
//
// NOTHING HERE CHANGES A FINDING. Deciding a suggestion stores the decision on the
// suggestion row and stops there; moving the finding is the existing
// PATCH /findings/:id, done by the same person, with a note (D9a). The web app
// reads only this API, which reads only our Postgres.

export const AI_PASSES_PER_DAY = 10;

/** W20-21 (UX_TODO AI-31): how much the start form's pickers offer. */
export const PICKER_PRS = 50;
export const PICKER_COMMITS = 50;
export const PICKER_FILES = 2000;

/** W20-11 (UX_TODO AI-40): how long the person who answered a suggestion may withdraw it. */
export const AI_DECISION_UNDO_MINUTES = 15;
/** W20-16 (UX_TODO AI-40): longest "why" note kept with an answer. */
export const AI_DECISION_NOTE_MAX = 500;

/**
 * Passes that RAN in this workspace in the last 24 hours (W20-11, UX_TODO
 * AI-61): skipped scheduled ticks are left out, failed passes count. Second
 * opinions are pass rows, so they count too (decision 2026-10-20).
 */
export async function passesInLastDay(
  db: Database,
  workspaceId: number,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, workspaceId),
        gte(read.aiPassRuns.createdAt, since),
        sql`${read.aiPassRuns.status} <> 'skipped'`,
        // W22-03: judge runs follow scans, not people; not on the daily limit.
        sql`${read.aiPassRuns.mode} <> 'judge'`,
        // W25-01: nor is a repository's one first look after its first scan.
        sql`${read.aiPassRuns.trigger} <> 'after_scan'`,
      ),
    );
  return n;
}

export interface AiPassRoutesOptions {
  db: Database;
  redisUrl?: string | undefined;
  /** Injectable so tests exercise the routes without Redis. */
  queueFor?: (queue: QueueName) => Queue | undefined;
  now?: () => Date;
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

/** A path must be a plain repository-relative file or directory: no traversal, no absolute path. */
export function cleanPaths(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'Name the files or directories to review (paths). A pass is bounded: it never reads the whole repository.';
  }
  if (raw.length > AI_PASS_MAX_PATHS) return `At most ${AI_PASS_MAX_PATHS} paths.`;
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string') return 'Each path must be a string.';
    const t = p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (
      t === '' ||
      t.length > 300 ||
      t.startsWith('/') ||
      t.split('/').includes('..') ||
      t.includes('\0') ||
      t.includes('\\')
    ) {
      return `"${p}" is not a repository-relative path.`;
    }
    out.push(t);
  }
  return [...new Set(out)].sort();
}

interface ScopeBody {
  paths?: unknown;
  pull_request?: unknown;
  base?: unknown;
  head?: unknown;
  /**
   * W25-07: read every file (or the whole pull request diff) again even when
   * only some changed since the last clean pass over the same scope.
   */
  full_review?: unknown;
}

export interface PassScope {
  mode: 'paths' | 'pull_request' | 'commit_range';
  paths: string[];
  prNumber: number | null;
  baseRef: string | null;
  headRef: string | null;
}

/** Exactly one scope: typed paths, a pull request, or a base..head commit range. */
export function parseScope(body: ScopeBody | undefined): PassScope | string {
  const given = [
    body?.paths !== undefined,
    body?.pull_request !== undefined,
    body?.base !== undefined || body?.head !== undefined,
  ].filter(Boolean).length;
  if (given === 0) {
    return 'Name what to review: paths, a pull request number, or a base and head commit. A pass is bounded: it never reads the whole repository.';
  }
  if (given > 1) {
    return 'Name exactly one thing to review: paths, a pull request number, or a base and head commit.';
  }
  if (body?.pull_request !== undefined) {
    const n = body.pull_request;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 2_147_483_647)
      return 'pull_request must be a pull request number.';
    return { mode: 'pull_request', paths: [], prNumber: n, baseRef: null, headRef: null };
  }
  if (body?.base !== undefined || body?.head !== undefined) {
    const sha = /^[0-9a-f]{7,64}$/i;
    if (
      typeof body.base !== 'string' ||
      typeof body.head !== 'string' ||
      !sha.test(body.base.trim()) ||
      !sha.test(body.head.trim())
    ) {
      return 'A commit range needs both base and head as commit ids (7 to 64 hex characters).';
    }
    return {
      mode: 'commit_range',
      paths: [],
      prNumber: null,
      baseRef: body.base.trim().toLowerCase(),
      headRef: body.head.trim().toLowerCase(),
    };
  }
  const paths = cleanPaths(body?.paths);
  if (typeof paths === 'string') return paths;
  return { mode: 'paths', paths, prNumber: null, baseRef: null, headRef: null };
}

export default async function aiPassRoutes(
  app: FastifyInstance,
  opts: AiPassRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
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

  // Scheduled passes (W19-12): opt-in per repository; the worker starts them.
  await app.register(scheduleRoutes, { db, now });

  const runView = (r: typeof read.aiPassRuns.$inferSelect, requestedBy: string | null) => ({
    id: r.id,
    status: r.status,
    mode: r.mode,
    trigger: r.trigger,
    paths: r.paths,
    base_ref: r.baseRef,
    head_ref: r.headRef,
    pr_number: r.prNumber,
    // W23-07: "incremental since <sha7>" - the head the base review read.
    scope: r.scope,
    incremental_since:
      r.scope === 'incremental'
        ? ((r.specialists as { incremental?: { sinceSha?: string } } | null)?.incremental
            ?.sinceSha ?? null)
        : null,
    commit_sha: r.commitSha,
    reason_code: r.reasonCode,
    reason: r.reason,
    plan: r.plan,
    specialists: r.specialists,
    triage_funnel: r.triageFunnel,
    triage_skipped: r.triageSkipped,
    calls: r.calls,
    requested_by: requestedBy,
    created_at: r.createdAt,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
  });

  async function ownRepo(workspaceId: number, repoId: number): Promise<boolean> {
    const [repo] = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
      .limit(1);
    return repo !== undefined;
  }

  app.post<{ Params: { id: string }; Body: ScopeBody }>(
    '/repos/:id/ai-pass',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.id);
      if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repository id');
      if (!(await ownRepo(workspaceId, repoId)))
        return fail(request, reply, 404, 'No such repository');

      const scope = parseScope(request.body);
      if (typeof scope === 'string') return fail(request, reply, 400, 'Name what to review', scope);
      // W20-18 (UX_TODO AI-77): the workspace's "AI off" switch.
      if (await refuseWhenAiPaused(db, request, reply, workspaceId, 'no AI pass can start')) {
        return reply;
      }

      // One active pass per repository: a second click returns the first.
      const [active] = await db
        .select()
        .from(read.aiPassRuns)
        .where(
          and(
            eq(read.aiPassRuns.workspaceId, workspaceId),
            eq(read.aiPassRuns.repoId, repoId),
            sql`status in ('pending', 'running')`,
            // W22-03: a judge run after a scan does not stand in for a person's pass.
            sql`${read.aiPassRuns.mode} <> 'judge'`,
          ),
        )
        .limit(1);
      if (active) return reply.code(202).send({ run: runView(active, null) });

      // W20-11 (UX_TODO AI-61): only passes that RAN count. A scheduled tick
      // that refused to start writes a `skipped` row; counting those let a few
      // quiet schedules block every manual pass with "10 passes started" while
      // the panel listed fewer. Failed passes did run (and spent calls), so
      // they still count, and the message says so.
      const n = await passesInLastDay(db, workspaceId, now());
      if (n >= AI_PASSES_PER_DAY) {
        return fail(
          request,
          reply,
          429,
          'Daily AI-pass limit reached',
          `${n} passes ran in this workspace in the last 24 hours, failed ones included (limit ${AI_PASSES_PER_DAY}). Each is many model calls over your source.`,
        );
      }

      const queue = queueFor(QUEUE.aiPass);
      if (!queue) {
        return fail(
          request,
          reply,
          503,
          'The job queue is unavailable',
          'Redis is not reachable from the API, so nothing can be started right now.',
        );
      }

      let run: typeof read.aiPassRuns.$inferSelect;
      try {
        const [inserted] = await db
          .insert(read.aiPassRuns)
          .values({
            workspaceId,
            repoId,
            requestedBy: userId,
            paths: scope.paths,
            mode: scope.mode,
            prNumber: scope.prNumber,
            baseRef: scope.baseRef,
            headRef: scope.headRef,
            createdAt: now(),
          })
          .returning();
        run = inserted!;
      } catch (err) {
        // Lost a race with a second click: the other request's pass stands.
        if (isConstraintViolation(err, 'ai_pass_runs_one_active_key')) {
          return fail(request, reply, 409, 'A pass is already running for this repository');
        }
        throw err;
      }

      await queue.add(
        'ai.pass',
        {
          workspaceId,
          runId: run.id,
          requestId: request.id,
          ...(request.body?.full_review === true ? { force: true } : {}),
        },
        { jobId: `ai-pass-${run.id}` },
      );
      auditLog(request.log, {
        event: 'ai_pass.started',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: {
          run_id: run.id,
          repo_id: repoId,
          mode: scope.mode,
          paths: scope.paths,
          pr_number: scope.prNumber,
          base: scope.baseRef,
          head: scope.headRef,
        },
      });
      return reply.code(202).send({ run: runView(run, null) });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/repos/:id/ai-pass',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.id);
      if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repository id');
      if (!(await ownRepo(workspaceId, repoId)))
        return fail(request, reply, 404, 'No such repository');
      const asked = Number(request.query?.limit ?? 10);
      const limit = Number.isInteger(asked) ? Math.min(50, Math.max(1, asked)) : 10;

      // W20-11 (UX_TODO AI-81): scheduled ticks that refused to run write a
      // `skipped` row every few hours, and those used to fill the ten newest, so
      // the panel (which hides them) showed few passes or none, and could say
      // "not yet run" on a reviewed repository. They are left out here; the
      // Scheduled passes section lists them from its own route.
      const notScheduledSkip = sql`not (${read.aiPassRuns.trigger} = 'scheduled' and ${read.aiPassRuns.status} = 'skipped')`;
      const rows = await db
        .select({ run: read.aiPassRuns, login: core.users.login })
        .from(read.aiPassRuns)
        .leftJoin(core.users, eq(core.users.id, read.aiPassRuns.requestedBy))
        .where(
          and(
            eq(read.aiPassRuns.workspaceId, workspaceId),
            eq(read.aiPassRuns.repoId, repoId),
            notScheduledSkip,
          ),
        )
        .orderBy(desc(read.aiPassRuns.createdAt))
        .limit(limit + 1);
      // No pass ever started is `runs: []` - the screen says "not yet run", never
      // "clean". With skips left out, an empty list now really means that.
      return reply.send({
        runs: rows.slice(0, limit).map((r) => runView(r.run, r.login ?? null)),
        more: rows.length > limit,
        // W20-18 (UX_TODO AI-77): the panel says why Start is off.
        ai_paused: await aiPauseState(db, workspaceId),
        // W20-21 (UX_TODO AI-56): who can start one, named for a member.
        admins: await adminLogins(workspaceId),
      });
    },
  );

  /** The workspace's admins, by login, for "ask an admin" (W20-21, AI-56). */
  async function adminLogins(workspaceId: number): Promise<string[]> {
    const rows = await db
      .select({ login: core.users.login })
      .from(core.workspaceMembers)
      .innerJoin(core.users, eq(core.users.id, core.workspaceMembers.userId))
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          eq(core.workspaceMembers.role, 'admin'),
        ),
      )
      .orderBy(core.users.login)
      .limit(20);
    return rows.map((r) => r.login);
  }

  /**
   * POST /repos/:id/ai-pass/:runId/cancel — stop a queued or running pass
   * (W20-21, UX_TODO AI-33). Admin-only, like starting one.
   *
   * The row is marked failed with reason `cancelled` at once, which frees the
   * repository for another pass. A queued job is removed; a running one stops
   * at its next model call, because the worker checks the row before each call
   * (ai-pass-processor's cancellation check) and never overwrites a cancelled
   * row when it ends. Calls already made stay counted.
   */
  app.post<{ Params: { id: string; runId: string } }>(
    '/repos/:id/ai-pass/:runId/cancel',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.id);
      const runId = Number(request.params.runId);
      if (!Number.isInteger(repoId) || !Number.isInteger(runId)) {
        return fail(request, reply, 400, 'Invalid id');
      }
      const [login] = await db
        .select({ login: core.users.login })
        .from(core.users)
        .where(eq(core.users.id, userId))
        .limit(1);
      const [cancelled] = await db
        .update(read.aiPassRuns)
        .set({
          status: 'failed',
          reasonCode: 'cancelled',
          reason: `Cancelled by ${login?.login ?? 'an admin'}. Model calls already made still count toward the monthly total.`,
          finishedAt: now(),
        })
        .where(
          and(
            eq(read.aiPassRuns.id, runId),
            eq(read.aiPassRuns.workspaceId, workspaceId),
            eq(read.aiPassRuns.repoId, repoId),
            inArray(read.aiPassRuns.status, ['pending', 'running']),
          ),
        )
        .returning();
      if (!cancelled) {
        // Tenancy (Law 5): another workspace's pass reads as absent too.
        const [exists] = await db
          .select({ status: read.aiPassRuns.status })
          .from(read.aiPassRuns)
          .where(
            and(
              eq(read.aiPassRuns.id, runId),
              eq(read.aiPassRuns.workspaceId, workspaceId),
              eq(read.aiPassRuns.repoId, repoId),
            ),
          )
          .limit(1);
        if (!exists) return fail(request, reply, 404, 'No such pass');
        return fail(request, reply, 409, 'The pass has already ended', `It is ${exists.status}.`);
      }
      // A queued job is taken off the queue. A running one cannot be removed
      // (its lock is held); the worker sees the row and stops by itself.
      const queue = queueFor(QUEUE.aiPass);
      if (queue) {
        try {
          const job = await queue.getJob(`ai-pass-${runId}`);
          if (job && (await job.getState()) !== 'active') await job.remove();
        } catch {
          // Best effort: the worker skips a job whose row is no longer pending.
        }
      }
      auditLog(request.log, {
        event: 'ai_pass.cancelled',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: { run_id: runId, repo_id: repoId },
      });
      return reply.send({ run: runView(cancelled, null) });
    },
  );

  /**
   * POST /repos/:id/ai-pass/ask — a member asks the admins for a pass (W20-21,
   * UX_TODO AI-56). Members cannot start one; they could only read "An admin
   * starts a pass." This records the request (audited, `ai_pass.requested`),
   * which the admins' inbox lists. Nothing is sent to a model.
   */
  app.post<{ Params: { id: string }; Body: { paths?: unknown; note?: unknown } | undefined }>(
    '/repos/:id/ai-pass/ask',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.id);
      if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repository id');
      const [repo] = await db
        .select({ org: core.repos.org, name: core.repos.name })
        .from(core.repos)
        .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      if (!repo) return fail(request, reply, 404, 'No such repository');
      let paths: string[] = [];
      if (request.body?.paths !== undefined && request.body.paths !== null) {
        const cleaned = cleanPaths(request.body.paths);
        if (typeof cleaned === 'string') return fail(request, reply, 400, 'Invalid paths', cleaned);
        paths = cleaned;
      }
      const note =
        typeof request.body?.note === 'string' ? request.body.note.trim().slice(0, 500) : '';
      auditLog(request.log, {
        event: 'ai_pass.requested',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        repo_id: repoId,
        repo: `${repo.org}/${repo.name}`,
        paths,
        note: note === '' ? null : note,
      });
      return reply.code(202).send({ asked: true, admins: await adminLogins(workspaceId) });
    },
  );

  /**
   * GET /repos/:id/ai-pass/pickers — what the start form can offer instead of
   * typing (W20-21, UX_TODO AI-31): ingested pull requests, recent non-merge
   * commits and the repository's known file paths. All from our own database
   * (Law 4); workspace-filtered (Law 5).
   */
  app.get<{ Params: { id: string } }>('/repos/:id/ai-pass/pickers', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.id);
    if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repository id');
    if (!(await ownRepo(workspaceId, repoId))) {
      return fail(request, reply, 404, 'No such repository');
    }
    const prs = await db
      .select({
        number: facts.pullRequests.number,
        title: facts.pullRequests.title,
        state: facts.pullRequests.state,
      })
      .from(facts.pullRequests)
      .where(
        and(eq(facts.pullRequests.workspaceId, workspaceId), eq(facts.pullRequests.repoId, repoId)),
      )
      .orderBy(desc(facts.pullRequests.updatedAt))
      .limit(PICKER_PRS);
    const commits = await db
      .select({
        sha: facts.commits.sha,
        message: facts.commits.messageHead,
        at: facts.commits.committedAt,
      })
      .from(facts.commits)
      .where(
        and(
          eq(facts.commits.workspaceId, workspaceId),
          eq(facts.commits.repoId, repoId),
          eq(facts.commits.isMerge, false),
        ),
      )
      .orderBy(desc(facts.commits.committedAt))
      .limit(PICKER_COMMITS);
    const files = await db
      .selectDistinct({ path: facts.commitFiles.path })
      .from(facts.commitFiles)
      .where(
        and(eq(facts.commitFiles.workspaceId, workspaceId), eq(facts.commitFiles.repoId, repoId)),
      )
      .orderBy(facts.commitFiles.path)
      .limit(PICKER_FILES + 1);
    return reply.send({
      prs: prs.map((p) => ({ number: p.number, title: p.title, state: p.state })),
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.message.slice(0, 120),
        at: c.at.toISOString(),
      })),
      files: files.slice(0, PICKER_FILES).map((f) => f.path),
      files_truncated: files.length > PICKER_FILES,
    });
  });

  app.get<{ Params: { id: string } }>('/findings/:id/ai', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const findingId = Number(request.params.id);
    if (!Number.isInteger(findingId)) return fail(request, reply, 400, 'Invalid finding id');
    const [finding] = await db
      .select({ id: read.findings.id, repoId: read.findings.repoId })
      .from(read.findings)
      .where(and(eq(read.findings.id, findingId), eq(read.findings.workspaceId, workspaceId)))
      .limit(1);
    if (!finding) return fail(request, reply, 404, 'No such finding');

    const [prov] = await db
      .select()
      .from(read.aiFindingProvenance)
      .where(
        and(
          eq(read.aiFindingProvenance.findingId, findingId),
          eq(read.aiFindingProvenance.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(read.aiFindingProvenance.createdAt))
      .limit(1);
    const verdicts = await db
      .select({ v: read.aiTriageVerdicts, login: core.users.login })
      .from(read.aiTriageVerdicts)
      .leftJoin(core.users, eq(core.users.id, read.aiTriageVerdicts.decidedBy))
      .where(
        and(
          eq(read.aiTriageVerdicts.findingId, findingId),
          eq(read.aiTriageVerdicts.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(read.aiTriageVerdicts.createdAt));

    // What each pass reviewed (typed paths, a pull request or a commit range), so the
    // screen can say it next to the answer.
    const passIds = [
      ...new Set([...(prov ? [prov.aiPassRunId] : []), ...verdicts.map((x) => x.v.aiPassRunId)]),
    ];
    const passRows =
      passIds.length === 0
        ? []
        : await db
            .select()
            .from(read.aiPassRuns)
            .where(
              and(
                eq(read.aiPassRuns.workspaceId, workspaceId),
                inArray(read.aiPassRuns.id, passIds),
              ),
            );
    const passOf = (id: number) => {
      const r = passRows.find((x) => x.id === id);
      return r
        ? {
            id: r.id,
            mode: r.mode,
            pr_number: r.prNumber,
            base_ref: r.baseRef,
            head_ref: r.headRef,
            commit_sha: r.commitSha,
            paths: r.paths,
          }
        : null;
    };

    // W20-18 (UX_TODO AI-14): who could give a second opinion on the newest
    // first-opinion suggestion, where that would send code, and the latest ask.
    const firstOpinion = verdicts.find((x) => x.v.secondOpinionOf === null)?.v;
    const askedRows = await db
      .select()
      .from(read.aiPassRuns)
      .where(
        and(
          eq(read.aiPassRuns.workspaceId, workspaceId),
          eq(read.aiPassRuns.repoId, finding.repoId),
          eq(read.aiPassRuns.mode, 'second_opinion'),
          sql`${read.aiPassRuns.plan} -> 'second_opinion' ->> 'finding_id' = ${String(findingId)}`,
        ),
      )
      .orderBy(desc(read.aiPassRuns.createdAt))
      .limit(1);
    const asked = askedRows[0];
    const paused = await aiPauseState(db, workspaceId);
    const secondOpinion = firstOpinion
      ? {
          of: firstOpinion.id,
          ...(await secondOpinionOptions(db, workspaceId, finding.repoId, firstOpinion.model)),
          sends: SECOND_OPINION_SENDS,
          passes_today: await passesInLastDay(db, workspaceId, now()),
          passes_per_day: AI_PASSES_PER_DAY,
          latest: asked
            ? {
                id: asked.id,
                status: asked.status,
                reason: asked.reason,
                created_at: asked.createdAt,
                destination: (asked.plan as { second_opinion?: unknown } | null)?.second_opinion,
              }
            : null,
        }
      : null;

    return reply.send({
      ai_paused: paused,
      second_opinion: secondOpinion,
      // Raised by a model (a specialist), and how - or null for a rule-raised finding.
      raised_by: prov
        ? {
            specialist: prov.specialist,
            checklist_version: prov.checklistVersion,
            model: prov.model,
            route: prov.route,
            pass_id: prov.aiPassRunId,
            pass: passOf(prov.aiPassRunId),
          }
        : null,
      // Always labelled AI on the screen. Suggestions, never decisions.
      suggestions: verdicts.map(({ v, login }) => ({
        id: v.id,
        verdict: v.verdict,
        confidence: v.confidence,
        rationale: v.rationale,
        citations: v.citations,
        vex: v.vexJustification
          ? { justification: v.vexJustification, statement: v.vexStatement }
          : null,
        patch: { status: v.patchStatus, reason: v.patchReason, diff: v.patchDiff },
        model: v.model,
        checklist_version: v.checklistVersion,
        route: v.route,
        pass_id: v.aiPassRunId,
        pass: passOf(v.aiPassRunId),
        created_at: v.createdAt,
        decision: v.decision,
        decided_by: login ?? null,
        decided_at: v.decidedAt,
        decision_note: v.decisionNote,
        // W20-18 (UX_TODO AI-14): another model's answer about the same
        // finding, checking suggestion `second_opinion_of`. Not answered alone.
        second_opinion_of: v.secondOpinionOf,
        // W20-11 (UX_TODO AI-40): whether the caller may still withdraw the answer.
        can_undo:
          v.decidedBy !== null &&
          v.decidedBy === request.session?.get('userId') &&
          v.decidedAt !== null &&
          (v.decision === 'accepted' || v.decision === 'dismissed') &&
          now().getTime() - v.decidedAt.getTime() < AI_DECISION_UNDO_MINUTES * 60 * 1000,
      })),
    });
  });

  app.post<{
    Params: { id: string; verdictId: string };
    Body: { decision?: unknown; undo?: unknown; note?: unknown };
  }>('/findings/:id/ai-verdicts/:verdictId/decide', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session?.get('userId');
    if (workspaceId === undefined || userId === undefined)
      return fail(request, reply, 401, 'No active session');
    const findingId = Number(request.params.id);
    const verdictId = Number(request.params.verdictId);
    if (!Number.isInteger(findingId) || !Number.isInteger(verdictId))
      return fail(request, reply, 400, 'Invalid id');

    // W20-11 (UX_TODO AI-40): an answer was final from the first click, so a
    // mis-click on Dismiss could never be taken back. The person who answered
    // may withdraw it for a short while; after that, or for anyone else, it
    // stands. Still nothing about the finding moves.
    if (request.body?.undo === true) {
      const cutoff = new Date(now().getTime() - AI_DECISION_UNDO_MINUTES * 60 * 1000);
      // A finding holds at most one unanswered suggestion; reopening this one
      // while a newer one waits is refused by that index, and said so below.
      const undone = await db
        .update(read.aiTriageVerdicts)
        .set({ decision: null, decidedBy: null, decidedAt: null, decisionNote: null })
        .where(
          and(
            eq(read.aiTriageVerdicts.id, verdictId),
            eq(read.aiTriageVerdicts.findingId, findingId),
            eq(read.aiTriageVerdicts.workspaceId, workspaceId),
            eq(read.aiTriageVerdicts.decidedBy, userId),
            gte(read.aiTriageVerdicts.decidedAt, cutoff),
            sql`${read.aiTriageVerdicts.decision} in ('accepted', 'dismissed')`,
          ),
        )
        .returning({ id: read.aiTriageVerdicts.id })
        .catch((err: unknown) => {
          if (isConstraintViolation(err, 'ai_triage_verdicts_one_open_key')) return [];
          throw err;
        });
      if (undone.length === 0) {
        return fail(
          request,
          reply,
          409,
          'This answer can no longer be changed',
          `Only the person who answered can change it, within ${AI_DECISION_UNDO_MINUTES} minutes.`,
        );
      }
      auditLog(request.log, {
        // The same event as an answer, recording that it was withdrawn.
        event: 'ai_verdict.decided',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: { finding_id: findingId, verdict_id: verdictId, decision: null, undone: true },
      });
      return reply.send({ id: verdictId, decision: null });
    }

    const decision = request.body?.decision;
    if (decision !== 'accepted' && decision !== 'dismissed') {
      return fail(
        request,
        reply,
        400,
        'Invalid decision',
        'decision must be "accepted" or "dismissed".',
      );
    }

    // W20-16 (UX_TODO AI-40): an optional "why", up to 500 characters.
    const rawNote = request.body?.note;
    if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
      return fail(request, reply, 400, 'Invalid note', 'note must be text.');
    }
    const note = typeof rawNote === 'string' ? rawNote.trim() : '';
    if (note.length > AI_DECISION_NOTE_MAX) {
      return fail(
        request,
        reply,
        400,
        'Note too long',
        `Keep the note to ${AI_DECISION_NOTE_MAX} characters.`,
      );
    }

    // Compare-and-set: only an undecided suggestion of THIS workspace and finding.
    const rows = await db
      .update(read.aiTriageVerdicts)
      .set({ decision, decidedBy: userId, decidedAt: now(), decisionNote: note || null })
      .where(
        and(
          eq(read.aiTriageVerdicts.id, verdictId),
          eq(read.aiTriageVerdicts.findingId, findingId),
          eq(read.aiTriageVerdicts.workspaceId, workspaceId),
          sql`decision is null`,
          // W20-18: a second opinion is read beside the suggestion it checks;
          // the person answers the original.
          isNull(read.aiTriageVerdicts.secondOpinionOf),
        ),
      )
      .returning({ id: read.aiTriageVerdicts.id, verdict: read.aiTriageVerdicts.verdict });
    if (rows.length === 0) {
      const [exists] = await db
        .select({
          decision: read.aiTriageVerdicts.decision,
          secondOpinionOf: read.aiTriageVerdicts.secondOpinionOf,
        })
        .from(read.aiTriageVerdicts)
        .where(
          and(
            eq(read.aiTriageVerdicts.id, verdictId),
            eq(read.aiTriageVerdicts.findingId, findingId),
            eq(read.aiTriageVerdicts.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (exists && exists.secondOpinionOf !== null) {
        return fail(
          request,
          reply,
          409,
          'A second opinion is not answered on its own',
          'Answer the suggestion it checks; the second opinion is shown beside it.',
        );
      }
      return exists
        ? fail(
            request,
            reply,
            409,
            'Already decided',
            `This suggestion was already ${exists.decision}.`,
          )
        : fail(request, reply, 404, 'No such suggestion');
    }
    auditLog(request.log, {
      event: 'ai_verdict.decided',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      detail: {
        finding_id: findingId,
        verdict_id: verdictId,
        verdict: rows[0]!.verdict,
        decision,
      },
    });
    // Deliberately nothing about the finding: its status is moved by the person
    // through PATCH /findings/:id, with a note.
    return reply.send({ id: verdictId, decision });
  });

  /**
   * POST /findings/:id/ai-verdicts/:verdictId/second-opinion (W20-18, UX_TODO
   * AI-14). Asks ANOTHER model to triage the same finding from the same stored
   * evidence, and stores its answer beside the first. Admin-only, like starting
   * a pass: it sends code to a model. A hosted (off-network) model only on a
   * repository opted in to Tier 3, never under local-only; it is a pass row, so
   * it counts toward the daily pass limit (decision 2026-10-20). Nothing about
   * the finding changes.
   */
  app.post<{
    Params: { id: string; verdictId: string };
    Body: { provider_id?: unknown } | undefined;
  }>(
    '/findings/:id/ai-verdicts/:verdictId/second-opinion',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const findingId = Number(request.params.id);
      const verdictId = Number(request.params.verdictId);
      if (!Number.isInteger(findingId) || !Number.isInteger(verdictId))
        return fail(request, reply, 400, 'Invalid id');
      const rawProvider = request.body?.provider_id;
      if (
        rawProvider !== undefined &&
        (typeof rawProvider !== 'number' || !Number.isInteger(rawProvider))
      ) {
        return fail(request, reply, 400, 'Invalid model', 'provider_id must be a connection id.');
      }

      const [row] = await db
        .select({ v: read.aiTriageVerdicts, f: read.findings })
        .from(read.aiTriageVerdicts)
        .innerJoin(read.findings, eq(read.findings.id, read.aiTriageVerdicts.findingId))
        .where(
          and(
            eq(read.aiTriageVerdicts.id, verdictId),
            eq(read.aiTriageVerdicts.findingId, findingId),
            eq(read.aiTriageVerdicts.workspaceId, workspaceId),
            eq(read.findings.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!row) return fail(request, reply, 404, 'No such suggestion');
      if (row.v.secondOpinionOf !== null) {
        return fail(
          request,
          reply,
          409,
          'Ask about the original suggestion',
          'This is already a second opinion. Ask another model about the suggestion it checks.',
        );
      }
      const f = row.f;
      if (!f.scannerKey || !f.ruleId || !f.file || f.lineStart === null || !f.contextLines) {
        return fail(
          request,
          reply,
          409,
          'No stored evidence to ask about',
          'A second opinion reads the same stored lines of code as the first, and this finding no longer has them.',
        );
      }

      if (
        await refuseWhenAiPaused(db, request, reply, workspaceId, 'no second opinion can be asked')
      ) {
        return reply;
      }

      const options = await secondOpinionOptions(db, workspaceId, f.repoId, row.v.model);
      const choice =
        rawProvider === undefined
          ? options.choices[0]
          : options.choices.find((c) => c.provider_id === rawProvider);
      if (!choice) {
        const why = options.blocked.map((b) => `${b.provider_name} (${b.reason})`).join('; ');
        return fail(
          request,
          reply,
          409,
          'No other model can give a second opinion',
          rawProvider !== undefined
            ? 'That connection cannot be asked for a second opinion here.' +
                (why ? ` Not available: ${why}.` : '')
            : `A second opinion needs a model other than ${row.v.model}.` +
                (why ? ` Not available: ${why}.` : ' Add one in Settings → Models.'),
        );
      }

      // One answer per model: asking the same model twice is shopping for a nicer answer.
      const [already] = await db
        .select({ id: read.aiTriageVerdicts.id })
        .from(read.aiTriageVerdicts)
        .where(
          and(
            eq(read.aiTriageVerdicts.workspaceId, workspaceId),
            eq(read.aiTriageVerdicts.secondOpinionOf, verdictId),
            eq(read.aiTriageVerdicts.model, choice.model),
          ),
        )
        .limit(1);
      if (already) {
        return fail(
          request,
          reply,
          409,
          'That model already gave a second opinion',
          `${choice.model} has already answered about this suggestion; it is shown beside it.`,
        );
      }

      const n = await passesInLastDay(db, workspaceId, now());
      if (n >= AI_PASSES_PER_DAY) {
        return fail(
          request,
          reply,
          429,
          'Daily AI-pass limit reached',
          `${n} passes ran in this workspace in the last 24 hours (limit ${AI_PASSES_PER_DAY}). A second opinion counts as a pass.`,
        );
      }

      const queue = queueFor(QUEUE.aiPass);
      if (!queue) {
        return fail(
          request,
          reply,
          503,
          'The job queue is unavailable',
          'Redis is not reachable from the API, so nothing can be started right now.',
        );
      }

      const destination = {
        verdict_id: verdictId,
        finding_id: findingId,
        provider_id: choice.provider_id,
        provider_name: choice.provider_name,
        host: choice.host,
        model: choice.model,
        leaves_network: choice.leaves_network,
      };
      let run: typeof read.aiPassRuns.$inferSelect;
      try {
        const [inserted] = await db
          .insert(read.aiPassRuns)
          .values({
            workspaceId,
            repoId: f.repoId,
            requestedBy: userId,
            paths: [f.file],
            mode: 'second_opinion',
            plan: { second_opinion: destination },
            createdAt: now(),
          })
          .returning();
        run = inserted!;
      } catch (err) {
        if (isConstraintViolation(err, 'ai_pass_runs_one_active_key')) {
          return fail(
            request,
            reply,
            409,
            'A pass is already running for this repository',
            'Ask again when it has finished.',
          );
        }
        throw err;
      }

      await queue.add(
        'ai.pass',
        { workspaceId, runId: run.id, requestId: request.id },
        { jobId: `ai-pass-${run.id}` },
      );
      auditLog(request.log, {
        event: 'ai_verdict.second_opinion_requested',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: {
          run_id: run.id,
          repo_id: f.repoId,
          finding_id: findingId,
          verdict_id: verdictId,
          provider_id: choice.provider_id,
          host: choice.host,
          model: choice.model,
          leaves_network: choice.leaves_network,
        },
      });
      return reply.code(202).send({ run: runView(run, null), destination });
    },
  );
}
