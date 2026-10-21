import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { auditLog, core, read, type Database } from '@repopulse/shared';
import { QUEUE, createQueue, createRedisConnection } from '@repopulse/ingest';
import type { Queue } from 'bullmq';
import { local } from '@repopulse/auth';
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

/**
 * What a member leaves behind (W20-19, UX_TODO ADM-48/49), counted for the
 * Remove confirmation and acted on by the delete: their unrevoked CI tokens are
 * revoked, their SHARED saved views move to the admin removing them (other
 * people use those), their private views go with the account, and the forge
 * connections they created stay with the workspace untouched.
 */
export async function memberHoldings(
  db: Database,
  workspaceId: number,
  userId: number,
): Promise<{
  ci_tokens: number;
  shared_views: number;
  private_views: number;
  connections: number;
}> {
  const [tokens] = await db
    .select({ n: count() })
    .from(core.ciTokens)
    .where(
      and(
        eq(core.ciTokens.workspaceId, workspaceId),
        eq(core.ciTokens.createdBy, userId),
        isNull(core.ciTokens.revokedAt),
      ),
    );
  const views = await db
    .select({ shared: read.savedViews.isShared, n: count() })
    .from(read.savedViews)
    .where(
      and(eq(read.savedViews.workspaceId, workspaceId), eq(read.savedViews.ownerUserId, userId)),
    )
    .groupBy(read.savedViews.isShared);
  const [conns] = await db
    .select({ n: count() })
    .from(core.forgeConnections)
    .where(
      and(
        eq(core.forgeConnections.workspaceId, workspaceId),
        eq(core.forgeConnections.createdBy, userId),
      ),
    );
  return {
    ci_tokens: tokens?.n ?? 0,
    shared_views: views.find((v) => v.shared)?.n ?? 0,
    private_views: views.find((v) => !v.shared)?.n ?? 0,
    connections: conns?.n ?? 0,
  };
}

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

/**
 * What a dead-lettered job was for, from its payload (W20-22, UX_TODO ADM-53).
 * Every ingest and scan payload carries `repoId`; report jobs carry
 * `reportId`; some carry a pull request or a scanner. Anything else is null.
 */
export function jobTarget(payload: unknown): { repoId: number | null; detail: string | null } {
  if (!payload || typeof payload !== 'object') return { repoId: null, detail: null };
  const p = payload as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
  const parts: string[] = [];
  if (num(p.reportId) !== null) parts.push(`report #${String(p.reportId)}`);
  if (num(p.prNumber) !== null) parts.push(`pull request #${String(p.prNumber)}`);
  if (typeof p.entityType === 'string') parts.push(p.entityType);
  if (typeof p.scannerKey === 'string') parts.push(`scanner ${p.scannerKey}`);
  if (typeof p.sha === 'string') parts.push(`commit ${p.sha.slice(0, 7)}`);
  return { repoId: num(p.repoId), detail: parts.length > 0 ? parts.join(' · ') : null };
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
        authProvider: core.users.authProvider,
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
        // W20-07 (UX_TODO INS-03): only a local account has a password here
        // to reset; GitHub and SSO users reset theirs with their provider.
        auth_provider: r.authProvider,
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
   * POST /admin/members/:userId/reset-password — a one-time temporary password
   * (W20-07, UX_TODO INS-03).
   *
   * Admin only, workspace-scoped, local accounts only, and audited. The
   * password is in this one response and nowhere else; the account must
   * replace it at its next sign-in. Every session the account already has is
   * ended (W20-10, UX_TODO ADM-78), so a reset also locks out whoever knew the
   * old password.
   */
  app.post<{ Params: { userId: string } }>(
    '/admin/members/:userId/reset-password',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const callerId = request.session.get('userId');
      if (workspaceId === undefined || callerId === undefined) {
        return problem(request, reply, 401, 'No active session');
      }
      const userId = Number(request.params.userId);
      if (!Number.isFinite(userId)) return problem(request, reply, 400, 'Invalid user id');

      // Tenancy (Law 5): only a member of THIS workspace, and another
      // workspace's user is a 404 rather than a 403.
      const [member] = await opts.db
        .select({ userId: core.workspaceMembers.userId })
        .from(core.workspaceMembers)
        .where(
          and(
            eq(core.workspaceMembers.workspaceId, workspaceId),
            eq(core.workspaceMembers.userId, userId),
          ),
        )
        .limit(1);
      if (!member) return problem(request, reply, 404, 'Member not found');

      const reset = await local.resetLocalPassword(opts.db, userId);
      if (!reset.ok) {
        if (reset.reason === 'not_found') return problem(request, reply, 404, 'Member not found');
        return problem(
          request,
          reply,
          409,
          'This member signs in with GitHub or single sign-on',
          'They have no RepoPulse password to reset; their password is managed by that provider.',
        );
      }

      // W20-10 (UX_TODO ADM-78): they were indexed per user for exactly this.
      const signedOut = (await app.sessionStore?.destroyUserSessions(userId)) ?? 0;

      auditLog(request.log, {
        event: 'auth.password_reset',
        sessionsEnded: signedOut,
        actorUserId: callerId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        targetUserId: userId,
        // Never the password: the audit stream is read far more widely.
      });
      return reply.send({
        user_id: userId,
        login: reset.user.login,
        temporary_password: reset.temporaryPassword,
        must_change_password: true,
        sessions_signed_out: signedOut,
      });
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
  /**
   * GET /admin/members/:userId/holdings — what removing this member would do
   * (W20-19, UX_TODO ADM-48/49): the counts the Remove confirmation states.
   */
  app.get<{ Params: { userId: string } }>(
    '/admin/members/:userId/holdings',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');
      const userId = Number(request.params.userId);
      if (!Number.isInteger(userId)) return problem(request, reply, 400, 'Invalid user id');
      const [member] = await opts.db
        .select({ userId: core.workspaceMembers.userId })
        .from(core.workspaceMembers)
        .where(
          and(
            eq(core.workspaceMembers.workspaceId, workspaceId),
            eq(core.workspaceMembers.userId, userId),
          ),
        )
        .limit(1);
      if (!member) return problem(request, reply, 404, 'Member not found');
      return reply.send(await memberHoldings(opts.db, workspaceId, userId));
    },
  );

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

      // W20-19 (UX_TODO ADM-48/49, decision 2026-10-20). In one transaction
      // with the delete, so a failure leaves the person, their tokens and
      // their views exactly as they were.
      const outcome = await opts.db.transaction(async (tx) => {
        // Their CI tokens stop working. They were only orphaned before
        // (created_by set null), so a pipeline kept reading findings with the
        // credential of someone who had left.
        const revoked = await tx
          .update(core.ciTokens)
          .set({ revokedAt: new Date(), revokedBy: callerId })
          .where(
            and(
              eq(core.ciTokens.workspaceId, workspaceId),
              eq(core.ciTokens.createdBy, userId),
              isNull(core.ciTokens.revokedAt),
            ),
          )
          .returning({ id: core.ciTokens.id });
        // Shared views stay with the workspace: the removing admin becomes
        // their owner, so the team views others use are not cascade-deleted
        // with the account. Never anyone's default by accident.
        const moved = await tx
          .update(read.savedViews)
          .set({ ownerUserId: callerId, isDefaultForOwner: false, updatedAt: new Date() })
          .where(
            and(
              eq(read.savedViews.workspaceId, workspaceId),
              eq(read.savedViews.ownerUserId, userId),
              eq(read.savedViews.isShared, true),
            ),
          )
          .returning({ id: read.savedViews.id });
        await tx.delete(core.users).where(eq(core.users.id, userId));
        return { revokedTokenIds: revoked.map((r) => r.id), movedViews: moved.length };
      });

      auditLog(request.log, {
        event: 'admin.member.removed',
        actorUserId: callerId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        targetUserId: userId,
        targetLogin: target?.login ?? null,
        ciTokensRevoked: outcome.revokedTokenIds.length,
        sharedViewsTransferred: outcome.movedViews,
      });
      for (const tokenId of outcome.revokedTokenIds) {
        auditLog(request.log, {
          event: 'ci_token.revoked',
          actorUserId: callerId,
          workspaceId,
          ip: request.ip,
          ua: request.headers['user-agent'] ?? null,
          tokenId,
          reason: 'member removed',
        });
      }

      return reply.send({
        user_id: userId,
        removed: true,
        ci_tokens_revoked: outcome.revokedTokenIds.length,
        shared_views_transferred: outcome.movedViews,
      });
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

      // W20-22 (UX_TODO ADM-53): which repository, report or pull request each
      // job was for, read from its payload. A repository that no longer exists
      // is said so: that job can never succeed, and Discard is the answer.
      const repoIds = [
        ...new Set(rows.map((r) => jobTarget(r.payload).repoId).filter((n) => n !== null)),
      ] as number[];
      const repos =
        repoIds.length === 0
          ? []
          : await opts.db
              .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
              .from(core.repos)
              .where(and(eq(core.repos.workspaceId, workspaceId), inArray(core.repos.id, repoIds)));
      const repoName = new Map(repos.map((r) => [r.id, `${r.org}/${r.name}`]));

      return reply.send({
        items: rows.map((r) => {
          const t = jobTarget(r.payload);
          return {
            id: r.id,
            queue: r.queue,
            job_id: r.jobId,
            // The error is the whole point of this screen — a DLQ showing a count
            // and no reason tells an operator nothing they can act on.
            error: r.error,
            failed_at: r.failedAt,
            replayed_at: r.replayedAt,
            target: {
              repo_id: t.repoId,
              repo: t.repoId === null ? null : (repoName.get(t.repoId) ?? null),
              repo_removed: t.repoId !== null && !repoName.has(t.repoId),
              detail: t.detail,
            },
          };
        }),
      });
    },
  );

  /**
   * POST /admin/dlq/:id/discard — drop a job that can never succeed (W20-22,
   * UX_TODO ADM-53), for example one whose repository was removed. The list
   * only grew. The row is deleted; the audit trail keeps what it was, who
   * discarded it and why (a reason is required).
   */
  app.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
    '/admin/dlq/:id/discard',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return problem(request, reply, 400, 'Invalid id');
      const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
      if (reason.length === 0 || reason.length > 500) {
        return problem(
          request,
          reply,
          400,
          'Say why it is discarded',
          'A reason of up to 500 characters is required; it is kept in the audit log.',
        );
      }
      const [row] = await opts.db
        .delete(core.jobFailure)
        .where(and(eq(core.jobFailure.id, id), eq(core.jobFailure.workspaceId, workspaceId)))
        .returning();
      // Tenancy (Law 5): another workspace's row is a 404.
      if (!row) return problem(request, reply, 404, 'Dead-letter job not found');
      auditLog(request.log, {
        event: 'dlq.job.discarded',
        actorUserId: request.session.get('userId') ?? null,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        failureId: id,
        queue: row.queue,
        jobId: row.jobId,
        reason,
        error: row.error.slice(0, 500),
      });
      return reply.send({ id, discarded: true });
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
