import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { auditLog, core, type Database } from '@repopulse/shared';
import { QUEUE, createQueue, createRedisConnection } from '@repopulse/ingest';
import type { Queue } from 'bullmq';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';

// Admin endpoints (W4-20): workspace members (FR-AUTH-4) and the dead-letter
// queue (NFR-11).
//
// The DLQ half is the consequential one. W12-05 made the dead-letter queue a
// deliberate SINK — exhausted jobs are copied there and nothing consumes them,
// precisely so a human can inspect and replay. Until these routes existed there
// was no way to do the inspecting, so a job that exhausted its retries landed
// somewhere nobody could see.
//
// ERROR RETURNS: `problem()` below sends AND returns the reply. Never write
// `return sendProblem(...)` — it returns void after already sending, so Fastify
// serialises `undefined` and sends a second time (ERR_HTTP_HEADERS_SENT on
// every problem response). api-v1.ts carries the same warning for its
// preHandler; it applies to handlers just as much.

export interface AdminRoutesOptions {
  db: Database;
  /** Needed to re-enqueue a replayed job. */
  redisUrl?: string;
  /** Injectable so tests replay without Redis. */
  queueFor?: (queue: string) => Queue | undefined;
}

const ROLES = ['admin', 'member'] as const;
type Role = (typeof ROLES)[number];

/** Send a problem response and hand Fastify the reply, in one expression. */
function problem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  sendProblem(request, reply, status, title, detail === undefined ? {} : { detail });
  return reply;
}

export default async function adminRoutes(
  app: FastifyInstance,
  opts: AdminRoutesOptions,
): Promise<void> {
  // Queues are created lazily and cached: building one per request would open a
  // Redis connection per replay click.
  const queues = new Map<string, Queue>();
  let connection: ReturnType<typeof createRedisConnection> | undefined;

  function queueFor(name: string): Queue | undefined {
    if (opts.queueFor) return opts.queueFor(name);
    if (!opts.redisUrl) return undefined;
    // Only queues we declare — a job_failure row naming an unknown queue must
    // not cause us to create one.
    const known = Object.values(QUEUE) as string[];
    if (!known.includes(name)) return undefined;
    let q = queues.get(name);
    if (!q) {
      connection ??= createRedisConnection(opts.redisUrl);
      q = createQueue(name as (typeof QUEUE)[keyof typeof QUEUE], connection);
      queues.set(name, q);
    }
    return q;
  }

  app.addHook('onClose', async () => {
    await Promise.all([...queues.values()].map((q) => q.close().catch(() => undefined)));
    if (connection) await connection.quit().catch(() => undefined);
  });

  /** GET /admin/members — who is in this workspace, and what they can do. */
  app.get('/admin/members', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');

    const rows = await opts.db
      .select({
        userId: core.workspaceMembers.userId,
        role: core.workspaceMembers.role,
        login: core.users.login,
        createdAt: core.workspaceMembers.createdAt,
      })
      .from(core.workspaceMembers)
      .innerJoin(core.users, eq(core.users.id, core.workspaceMembers.userId))
      .where(eq(core.workspaceMembers.workspaceId, workspaceId))
      .orderBy(core.users.login);

    return reply.send({
      items: rows.map((r) => ({
        user_id: r.userId,
        login: r.login,
        role: r.role,
        joined_at: r.createdAt,
      })),
    });
  });

  /** PATCH /admin/members/:userId — change one member's role. */
  app.patch<{ Params: { userId: string }; Body: { role?: string } }>(
    '/admin/members/:userId',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const callerId = request.session.get('userId');
      if (workspaceId === undefined || callerId === undefined) {
        return problem(request, reply, 401, 'No active session');
      }

      const userId = Number(request.params.userId);
      if (!Number.isFinite(userId)) return problem(request, reply, 400, 'Invalid user id');

      const role = request.body?.role;
      if (!role || !ROLES.includes(role as Role)) {
        // The DB CHECK would reject an unknown role too, but a 500 from a
        // constraint is not an answer an operator can act on.
        return problem(
          request,
          reply,
          400,
          'Invalid role',
          `role must be one of ${ROLES.join(', ')}`,
        );
      }

      // An admin demoting themselves while they are the LAST admin locks the
      // workspace out of every admin surface, including this endpoint, with no
      // way back in. Refused rather than "fixed" later by a support process.
      if (userId === callerId && role !== 'admin') {
        const admins = await opts.db
          .select({ userId: core.workspaceMembers.userId })
          .from(core.workspaceMembers)
          .where(
            and(
              eq(core.workspaceMembers.workspaceId, workspaceId),
              eq(core.workspaceMembers.role, 'admin'),
            ),
          );
        if (admins.length <= 1) {
          // 409, not 400: the request is well-formed, the STATE forbids it.
          return problem(
            request,
            reply,
            409,
            'Cannot remove the last admin',
            'Promote another member to admin first, or the workspace would have nobody who can administer it.',
          );
        }
      }

      // Read the CURRENT role before writing the new one. "role changed to
      // admin" cannot be read as a privilege escalation without knowing what
      // it was before, which is the whole reason T-29 wants the entry — and
      // after the UPDATE the old value is gone.
      const [before] = await opts.db
        .select({ role: core.workspaceMembers.role })
        .from(core.workspaceMembers)
        .where(
          and(
            eq(core.workspaceMembers.workspaceId, workspaceId),
            eq(core.workspaceMembers.userId, userId),
          ),
        )
        .limit(1);

      const updated = await opts.db
        .update(core.workspaceMembers)
        .set({ role })
        .where(
          and(
            eq(core.workspaceMembers.workspaceId, workspaceId),
            eq(core.workspaceMembers.userId, userId),
          ),
        )
        .returning({ userId: core.workspaceMembers.userId, role: core.workspaceMembers.role });

      // Tenancy (Law 5): a user in ANOTHER workspace is a 404 here, not a 403 —
      // a 403 would confirm the id exists somewhere.
      if (updated.length === 0) return problem(request, reply, 404, 'Member not found');

      // SC-22. Emitted only on the success path: the last-admin refusal and
      // the 404 changed nothing, and an audit stream that records attempts as
      // though they were changes is worse than one that records neither.
      auditLog(request.log, {
        event: 'admin.role.changed',
        actorUserId: callerId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        targetUserId: userId,
        fromRole: before?.role ?? null,
        toRole: updated[0]!.role,
      });

      return reply.send({ user_id: updated[0]!.userId, role: updated[0]!.role });
    },
  );

  /**
   * DELETE /admin/members/:userId — remove a person from the workspace (W16-59).
   *
   * Until this existed, a member who had used RepoPulse could not be removed at
   * all: every one of the seventeen foreign keys into `users` was NO ACTION, so
   * generating one report or triaging one finding made the account permanently
   * undeletable. The migration that fixed those is what makes this endpoint
   * possible, and this endpoint is what stops that migration being a schema
   * capability nothing calls.
   *
   * What survives is deliberate, not incidental. Reports, plans, agreements,
   * findings and their history all outlive the account — the work was done and
   * removing a login does not un-do it — with the author's login kept beside
   * the id on history rows so "who" survives too. Saved views go WITH the
   * person, because ownership there gates visibility and editing: an unowned
   * view would sit in nobody's list, editable by nobody.
   */
  app.delete<{ Params: { userId: string } }>(
    '/admin/members/:userId',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const callerId = request.session.get('userId');
      if (workspaceId === undefined || callerId === undefined) {
        return problem(request, reply, 401, 'No active session');
      }

      const userId = Number(request.params.userId);
      if (!Number.isFinite(userId)) return problem(request, reply, 400, 'Invalid user id');

      // Deleting YOURSELF is refused outright rather than guarded by the
      // last-admin rule. Even with other admins present it ends the session
      // mid-request and leaves the caller staring at a 401 from a screen they
      // were just using; an admin who wants to leave should be removed by
      // another admin, which is also the audit trail you want for it.
      if (userId === callerId) {
        return problem(
          request,
          reply,
          409,
          'Cannot remove your own account',
          'Ask another admin to remove it, so the action has someone behind it.',
        );
      }

      const [member] = await opts.db
        .select({ role: core.workspaceMembers.role })
        .from(core.workspaceMembers)
        .where(
          and(
            eq(core.workspaceMembers.workspaceId, workspaceId),
            eq(core.workspaceMembers.userId, userId),
          ),
        )
        .limit(1);
      // Tenancy (Law 5): a user in ANOTHER workspace is a 404, not a 403 — a
      // 403 would confirm the id exists somewhere.
      if (!member) return problem(request, reply, 404, 'Member not found');

      if (member.role === 'admin') {
        const admins = await opts.db
          .select({ userId: core.workspaceMembers.userId })
          .from(core.workspaceMembers)
          .where(
            and(
              eq(core.workspaceMembers.workspaceId, workspaceId),
              eq(core.workspaceMembers.role, 'admin'),
            ),
          );
        if (admins.length <= 1) {
          return problem(
            request,
            reply,
            409,
            'Cannot remove the last admin',
            'Promote another member to admin first, or the workspace would have nobody who can administer it.',
          );
        }
      }

      // The login is read BEFORE the delete, because the audit entry is about a
      // row that will not exist by the time it is written.
      const [target] = await opts.db
        .select({ login: core.users.login })
        .from(core.users)
        .where(eq(core.users.id, userId))
        .limit(1);

      await opts.db.delete(core.users).where(eq(core.users.id, userId));

      auditLog(request.log, {
        event: 'admin.member.removed',
        actorUserId: callerId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        targetUserId: userId,
        targetLogin: target?.login ?? null,
      });

      return reply.send({ user_id: userId, removed: true });
    },
  );

  /** GET /admin/dlq — jobs that exhausted their retries (NFR-11). */
  app.get<{ Querystring: { include_replayed?: string } }>(
    '/admin/dlq',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');

      const includeReplayed = request.query.include_replayed === 'true';
      const rows = await opts.db
        .select()
        .from(core.jobFailure)
        .where(
          includeReplayed
            ? eq(core.jobFailure.workspaceId, workspaceId)
            : and(eq(core.jobFailure.workspaceId, workspaceId), isNull(core.jobFailure.replayedAt)),
        )
        .orderBy(desc(core.jobFailure.failedAt))
        .limit(200);

      return reply.send({
        items: rows.map((r) => ({
          id: r.id,
          queue: r.queue,
          job_id: r.jobId,
          // The error is the whole point of this screen — a DLQ showing a count
          // and no reason tells an operator nothing they can act on.
          error: r.error,
          failed_at: r.failedAt,
          replayed_at: r.replayedAt,
        })),
      });
    },
  );

  /** POST /admin/dlq/:id/replay — re-enqueue one dead-lettered job. */
  app.post<{ Params: { id: string } }>(
    '/admin/dlq/:id/replay',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');

      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return problem(request, reply, 400, 'Invalid id');

      const [row] = await opts.db
        .select()
        .from(core.jobFailure)
        .where(and(eq(core.jobFailure.id, id), eq(core.jobFailure.workspaceId, workspaceId)))
        .limit(1);
      if (!row) return problem(request, reply, 404, 'Dead-letter job not found');

      const queue = queueFor(row.queue);
      if (!queue) {
        return problem(
          request,
          reply,
          503,
          'Replay unavailable',
          `No queue handle for "${row.queue}" — the API needs REDIS_URL to re-enqueue.`,
        );
      }

      // No jobId is set on the replay. The original id is the §6 idempotency
      // key, so reusing it would make BullMQ treat the replay as a duplicate of
      // the job that already failed: the button would appear to work and do
      // nothing.
      await queue.add(row.jobId, row.payload);

      // Stamped only AFTER a successful enqueue, so a failed replay stays
      // visible in the list rather than disappearing as though it had worked.
      await opts.db
        .update(core.jobFailure)
        .set({ replayedAt: new Date() })
        .where(eq(core.jobFailure.id, id));

      // After the stamp, for the same reason the stamp comes after the enqueue:
      // a failed replay must not leave a record saying it happened.
      auditLog(request.log, {
        event: 'dlq.job.replayed',
        actorUserId: request.session.get('userId') ?? null,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        failureId: id,
        queue: row.queue,
        jobId: row.jobId,
      });

      return reply.send({ id, queue: row.queue, replayed: true });
    },
  );
}
