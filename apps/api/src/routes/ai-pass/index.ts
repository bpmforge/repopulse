import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { auditLog, core, isConstraintViolation, read, type Database } from '@repopulse/shared';
import { QUEUE, createQueue, createRedisConnection, type QueueName } from '@repopulse/ingest';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';
import { AI_PASS_MAX_PATHS, AI_PASSES_PER_DAY } from '../../workers/ai-pass-processor.js';
import {
  AI_SCHEDULE_ACK_TEXT,
  AI_SCHEDULE_ACK_VERSION,
  nextDueAt,
  passesInLastDay,
  startedThisMonth,
} from '../../workers/ai-pass-schedule.js';

// The AI pass: start one, watch it, and read what it suggested (W19-09).
//
//   POST /repos/:id/ai-pass                 admin - queues a pass over named paths
//   GET  /repos/:id/ai-pass                 the repository's recent passes
//   GET  /findings/:id/ai                   how the finding was raised, and its AI suggestions
//   POST /findings/:id/ai-verdicts/:v/decide  a person accepts or dismisses a SUGGESTION
//   GET  /repos/:id/ai-pass/schedule        the repository's schedule (W19-12), off if never set
//   PUT  /repos/:id/ai-pass/schedule        admin - turning it on needs the acknowledgement
//
// NOTHING HERE CHANGES A FINDING. Deciding a suggestion stores the decision on the
// suggestion row and stops there; moving the finding is the existing
// PATCH /findings/:id, done by the same person, with a note (D9a). The web app
// reads only this API, which reads only our Postgres.

export { AI_PASSES_PER_DAY };

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

interface ScheduleBody {
  enabled?: unknown;
  scope?: unknown;
  paths?: unknown;
  cadence?: unknown;
  monthly_cap?: unknown;
  require_local?: unknown;
  acknowledge?: unknown;
}

export interface ParsedSchedule {
  enabled: boolean;
  scope: 'paths' | 'new_commits';
  paths: string[];
  cadence: 'daily' | 'weekly';
  monthlyCap: number;
  requireLocal: boolean;
  /** The acknowledgement version the person ticked, if they did. */
  acknowledge: string | null;
}

/** A whole schedule, every field named: a PUT replaces it, nothing is inferred. */
export function parseScheduleBody(body: ScheduleBody | undefined): ParsedSchedule | string {
  if (typeof body?.enabled !== 'boolean') return 'enabled must be true or false.';
  if (body.scope !== 'paths' && body.scope !== 'new_commits')
    return 'scope must be "paths" or "new_commits".';
  if (body.cadence !== 'daily' && body.cadence !== 'weekly')
    return 'cadence must be "daily" or "weekly".';
  const cap = body.monthly_cap;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1 || cap > 31)
    return 'monthly_cap must be a whole number from 1 to 31.';
  if (typeof body.require_local !== 'boolean') return 'require_local must be true or false.';
  let paths: string[] = [];
  if (body.scope === 'paths') {
    const cleaned = cleanPaths(body.paths);
    if (typeof cleaned === 'string') return cleaned;
    paths = cleaned;
  }
  const ack = body.acknowledge;
  if (ack !== undefined && ack !== null && typeof ack !== 'string')
    return 'acknowledge must be the acknowledgement version.';
  return {
    enabled: body.enabled,
    scope: body.scope,
    paths,
    cadence: body.cadence,
    monthlyCap: cap,
    requireLocal: body.require_local,
    acknowledge: typeof ack === 'string' ? ack : null,
  };
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
    trigger: r.trigger,
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

      const n = await passesInLastDay(db, workspaceId, now());
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

  // ---- Scheduled passes (W19-12) ------------------------------------------
  //
  // Off until an admin turns it on. Turning it on - or letting a schedule that
  // was local-only reach hosted models - needs the acknowledgement, in the exact
  // wording the screen showed (its version), and stores who and when.

  const scheduleView = async (
    workspaceId: number,
    repoId: number,
    row: typeof read.aiPassSchedules.$inferSelect | undefined,
  ) => {
    const at = now();
    let acknowledgedBy: string | null = null;
    if (row?.acknowledgedBy) {
      const [u] = await db
        .select({ login: core.users.login })
        .from(core.users)
        .where(eq(core.users.id, row.acknowledgedBy))
        .limit(1);
      acknowledgedBy = u?.login ?? null;
    }
    return {
      schedule: {
        saved: row !== undefined,
        enabled: row?.enabled ?? false,
        scope: row?.scope ?? 'new_commits',
        paths: row?.paths ?? [],
        cadence: row?.cadence ?? 'weekly',
        monthly_cap: row?.monthlyCap ?? 4,
        require_local: row?.requireLocal ?? true,
        acknowledged_by: row?.enabled ? acknowledgedBy : null,
        acknowledged_at: row?.enabled ? row.acknowledgedAt : null,
        ack_version: row?.enabled ? row.ackVersion : null,
        last_scheduled_at: row?.lastScheduledAt ?? null,
        last_head_sha: row?.lastHeadSha ?? null,
        next_due_at: row?.enabled ? nextDueAt(row, at) : null,
        started_this_month: await startedThisMonth(db, workspaceId, repoId, at),
        updated_at: row?.updatedAt ?? null,
      },
      acknowledgement: { version: AI_SCHEDULE_ACK_VERSION, text: AI_SCHEDULE_ACK_TEXT },
    };
  };

  async function loadSchedule(workspaceId: number, repoId: number) {
    const [row] = await db
      .select()
      .from(read.aiPassSchedules)
      .where(
        and(
          eq(read.aiPassSchedules.workspaceId, workspaceId),
          eq(read.aiPassSchedules.repoId, repoId),
        ),
      )
      .limit(1);
    return row;
  }

  app.get<{ Params: { id: string } }>('/repos/:id/ai-pass/schedule', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.id);
    if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repository id');
    if (!(await ownRepo(workspaceId, repoId)))
      return fail(request, reply, 404, 'No such repository');
    return reply.send(
      await scheduleView(workspaceId, repoId, await loadSchedule(workspaceId, repoId)),
    );
  });

  app.put<{ Params: { id: string }; Body: ScheduleBody }>(
    '/repos/:id/ai-pass/schedule',
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

      const body = parseScheduleBody(request.body);
      if (typeof body === 'string') return fail(request, reply, 400, 'Invalid schedule', body);

      const before = await loadSchedule(workspaceId, repoId);
      const turningOn = body.enabled && !before?.enabled;
      const wideningEgress =
        body.enabled && before?.enabled === true && before.requireLocal && !body.requireLocal;
      const needsAck = turningOn || wideningEgress;
      if (needsAck && body.acknowledge !== AI_SCHEDULE_ACK_VERSION) {
        return fail(
          request,
          reply,
          400,
          'Acknowledgement needed',
          turningOn
            ? 'Turning a schedule on sends this repository’s code to your models with nobody pressing start. Read and acknowledge the statement to turn it on.'
            : 'Letting this schedule use hosted models sends this repository’s code outside your network. Read and acknowledge the statement to allow it.',
        );
      }

      const at = now();
      const values = {
        enabled: body.enabled,
        scope: body.scope,
        paths: body.paths,
        cadence: body.cadence,
        monthlyCap: body.monthlyCap,
        requireLocal: body.requireLocal,
        updatedBy: userId,
        updatedAt: at,
        ...(needsAck
          ? { acknowledgedBy: userId, acknowledgedAt: at, ackVersion: AI_SCHEDULE_ACK_VERSION }
          : {}),
      };
      // Update when it exists, insert when it does not: Postgres checks the
      // proposed INSERT row against ai_pass_schedules_ack_check before any
      // ON CONFLICT, so an upsert of an unacknowledged edit would be refused.
      if (before) {
        await db
          .update(read.aiPassSchedules)
          .set(values)
          .where(
            and(
              eq(read.aiPassSchedules.id, before.id),
              eq(read.aiPassSchedules.workspaceId, workspaceId),
            ),
          );
      } else {
        try {
          await db
            .insert(read.aiPassSchedules)
            .values({ workspaceId, repoId, ...values, createdAt: at });
        } catch (err) {
          if (isConstraintViolation(err, 'ai_pass_schedules_workspace_repo_key')) {
            return fail(
              request,
              reply,
              409,
              'The schedule was changed at the same time; reload it',
            );
          }
          throw err;
        }
      }
      auditLog(request.log, {
        event: 'ai_pass.schedule_changed',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: {
          repo_id: repoId,
          enabled: body.enabled,
          scope: body.scope,
          paths: body.paths,
          cadence: body.cadence,
          monthly_cap: body.monthlyCap,
          require_local: body.requireLocal,
          acknowledged: needsAck ? AI_SCHEDULE_ACK_VERSION : null,
        },
      });
      return reply.send(
        await scheduleView(workspaceId, repoId, await loadSchedule(workspaceId, repoId)),
      );
    },
  );
}
