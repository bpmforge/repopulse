import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { QUEUE, createQueue, createRedisConnection } from '@repopulse/ingest';
import type { Queue } from 'bullmq';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';

// Admin endpoints (W4-20): workspace members (FR-AUTH-4) and the dead-letter
// queue (NFR-11).
//
// Both surfaces already existed in the UI as named empty states pointing at
// this ticket, which is the honest way to ship a gap — but the DLQ one is the
// consequential half. W12-05 made the DLQ a deliberate SINK: exhausted jobs are
// copied there and nothing consumes them, precisely so a human can inspect and
// replay. Until now there was no endpoint to do the inspecting, so a job that
// exhausted its retries landed somewhere nobody could see.

export interface AdminRoutesOptions {
  db: Database;
  /** Needed to re-enqueue a replayed job. */
  redisUrl?: string;
  /** Injectable so tests replay without Redis. */
  queueFor?: (queue: string) => Queue | undefined;
}

const ROLES = ['admin', 'member'] as const;
type Role = (typeof ROLES)[number];

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
    if (!Object.values(QUEUE).includes(name as (typeof QUEUE)[keyof typeof QUEUE]))
      return undefined;
    let q = queues.get(name);
    if (!q) {
      connection ??= createRedisConnection(opts.redisUrl);
      q = createQueue(name as (typeof QUEUE)[keyof typeof QUEUE], connection);
      queues.set(name, q);
    }
    return q;
  }

  app.addHook('onClose', async () => {
    await Promise.all([...queues.values()].map((q) => q.close().catch(() => {})));
    await connection?.quit().catch(() => {});
  });

  /** GET /admin/members — who is in this workspace and what they can do. */
  app.get('/admin/members', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return sendProblem(request, reply, 401, 'No active session');

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
        return sendProblem(request, reply, 401, 'No active session');
      }

      const userId = Number(request.params.userId);
      const role = request.body?.role;
      if (!Number.isFinite(userId)) {
        return sendProblem(request, reply, 400, 'Invalid user id');
      }
      if (!role || !ROLES.includes(role as Role)) {
        return sendProblem(request, reply, 400, 'Invalid role', {
          detail: `role must be one of ${ROLES.join(', ')}`,
        });
      }

      // An admin demoting themselves while they are the LAST admin locks the
      // workspace out of every admin surface with no way back in — including
      // this endpoint. Refused rather than "fixed" by a support process.
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
          return sendProblem(request, reply, 409, 'Cannot remove the last admin', {
            detail:
              'Promote another member to admin first, or the workspace would have no one who can administer it.',
          });
        }
      }

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
      // a 403 would confirm the id exists.
      if (updated.length === 0) return sendProblem(request, reply, 404, 'Member not found');
      return reply.send({ user_id: updated[0]!.userId, role: updated[0]!.role });
    },
  );

  /** GET /admin/dlq — jobs that exhausted their retries (NFR-11). */
  app.get<{ Querystring: { include_replayed?: string } }>(
    '/admin/dlq',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return sendProblem(request, reply, 401, 'No active session');

      const includeReplayed = request.query.include_replayed === 'true';
      const where = includeReplayed
        ? eq(core.jobFailure.workspaceId, workspaceId)
        : and(eq(core.jobFailure.workspaceId, workspaceId), isNull(core.jobFailure.replayedAt));

      const rows = await opts.db
        .select()
        .from(core.jobFailure)
        .where(where)
        .orderBy(desc(core.jobFailure.failedAt))
        .limit(200);

      return reply.send({
        items: rows.map((r) => ({
          id: r.id,
          queue: r.queue,
          job_id: r.jobId,
          // The error is the whole point of the screen — a DLQ that shows a
          // count and no reason tells an operator nothing actionable.
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
      if (workspaceId === undefined) return sendProblem(request, reply, 401, 'No active session');

      const id = Number(request.params.id);
      if (!Number.isFinite(id)) return sendProblem(request, reply, 400, 'Invalid id');

      const [row] = await opts.db
        .select()
        .from(core.jobFailure)
        .where(and(eq(core.jobFailure.id, id), eq(core.jobFailure.workspaceId, workspaceId)))
        .limit(1);
      if (!row) return sendProblem(request, reply, 404, 'Dead-letter job not found');

      const queue = queueFor(row.queue);
      if (!queue) {
        return sendProblem(request, reply, 503, 'Replay unavailable', {
          detail: `No queue handle for "${row.queue}" — the API needs REDIS_URL to re-enqueue.`,
        });
      }

      // No jobId is set on the replay. The original id is the §6 idempotency
      // key, and reusing it would make BullMQ treat the replay as a duplicate
      // of the job that already failed — the button would appear to work and
      // do nothing.
      await queue.add(row.jobId, row.payload);

      // Stamped only AFTER a successful enqueue, so a failed replay stays
      // visible in the list rather than disappearing as if it had worked.
      await opts.db
        .update(core.jobFailure)
        .set({ replayedAt: new Date() })
        .where(eq(core.jobFailure.id, id));

      return reply.send({ id, queue: row.queue, replayed: true });
    },
  );
}
