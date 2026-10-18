import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { auditLog, core, isConstraintViolation, read, type Database } from '@repopulse/shared';
import { QUEUE, createQueue, createRedisConnection, type QueueName } from '@repopulse/ingest';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';
import { AI_PASS_MAX_PATHS } from '../../workers/ai-pass-processor.js';

// The AI pass: start one, watch it, and read what it suggested (W19-09).
//
//   POST /repos/:id/ai-pass                 admin - queues a pass over named paths
//   GET  /repos/:id/ai-pass                 the repository's recent passes
//   GET  /findings/:id/ai                   how the finding was raised, and its AI suggestions
//   POST /findings/:id/ai-verdicts/:v/decide  a person accepts or dismisses a SUGGESTION
//
// NOTHING HERE CHANGES A FINDING. Deciding a suggestion stores the decision on the
// suggestion row and stops there; moving the finding is the existing
// PATCH /findings/:id, done by the same person, with a note (D9a). The web app
// reads only this API, which reads only our Postgres.

export const AI_PASSES_PER_DAY = 10;

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

  const runView = (r: typeof read.aiPassRuns.$inferSelect, requestedBy: string | null) => ({
    id: r.id,
    status: r.status,
    mode: r.mode,
    paths: r.paths,
    base_ref: r.baseRef,
    head_ref: r.headRef,
    pr_number: r.prNumber,
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

      // One active pass per repository: a second click returns the first.
      const [active] = await db
        .select()
        .from(read.aiPassRuns)
        .where(
          and(
            eq(read.aiPassRuns.workspaceId, workspaceId),
            eq(read.aiPassRuns.repoId, repoId),
            sql`status in ('pending', 'running')`,
          ),
        )
        .limit(1);
      if (active) return reply.code(202).send({ run: runView(active, null) });

      const since = new Date(now().getTime() - 24 * 60 * 60 * 1000);
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(read.aiPassRuns)
        .where(
          and(eq(read.aiPassRuns.workspaceId, workspaceId), gte(read.aiPassRuns.createdAt, since)),
        );
      if (n >= AI_PASSES_PER_DAY) {
        return fail(
          request,
          reply,
          429,
          'Daily AI-pass limit reached',
          `This workspace has started ${n} passes in the last 24 hours (limit ${AI_PASSES_PER_DAY}). Each is many model calls over your source.`,
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
        { workspaceId, runId: run.id, requestId: request.id },
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

  app.get<{ Params: { id: string } }>('/repos/:id/ai-pass', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.id);
    if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repository id');
    if (!(await ownRepo(workspaceId, repoId)))
      return fail(request, reply, 404, 'No such repository');

    const rows = await db
      .select({ run: read.aiPassRuns, login: core.users.login })
      .from(read.aiPassRuns)
      .leftJoin(core.users, eq(core.users.id, read.aiPassRuns.requestedBy))
      .where(and(eq(read.aiPassRuns.workspaceId, workspaceId), eq(read.aiPassRuns.repoId, repoId)))
      .orderBy(desc(read.aiPassRuns.createdAt))
      .limit(10);
    // No pass ever started is `runs: []` - the screen says "not yet run", never "clean".
    return reply.send({ runs: rows.map((r) => runView(r.run, r.login ?? null)) });
  });

  app.get<{ Params: { id: string } }>('/findings/:id/ai', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const findingId = Number(request.params.id);
    if (!Number.isInteger(findingId)) return fail(request, reply, 400, 'Invalid finding id');
    const [finding] = await db
      .select({ id: read.findings.id })
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

    return reply.send({
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
      })),
    });
  });

  app.post<{ Params: { id: string; verdictId: string }; Body: { decision?: unknown } }>(
    '/findings/:id/ai-verdicts/:verdictId/decide',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const findingId = Number(request.params.id);
      const verdictId = Number(request.params.verdictId);
      if (!Number.isInteger(findingId) || !Number.isInteger(verdictId))
        return fail(request, reply, 400, 'Invalid id');
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

      // Compare-and-set: only an undecided suggestion of THIS workspace and finding.
      const rows = await db
        .update(read.aiTriageVerdicts)
        .set({ decision, decidedBy: userId, decidedAt: now() })
        .where(
          and(
            eq(read.aiTriageVerdicts.id, verdictId),
            eq(read.aiTriageVerdicts.findingId, findingId),
            eq(read.aiTriageVerdicts.workspaceId, workspaceId),
            sql`decision is null`,
          ),
        )
        .returning({ id: read.aiTriageVerdicts.id, verdict: read.aiTriageVerdicts.verdict });
      if (rows.length === 0) {
        const [exists] = await db
          .select({ decision: read.aiTriageVerdicts.decision })
          .from(read.aiTriageVerdicts)
          .where(
            and(
              eq(read.aiTriageVerdicts.id, verdictId),
              eq(read.aiTriageVerdicts.findingId, findingId),
              eq(read.aiTriageVerdicts.workspaceId, workspaceId),
            ),
          )
          .limit(1);
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
    },
  );
}
