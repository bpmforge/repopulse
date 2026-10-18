import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, facts, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';

// Identity admin (W5-05, FR-AUTH-4 / FR-METRICS-3).
//
// One person is many identities: a GitHub login, a Gitea login, and every
// email address that ever authored a commit without a resolvable account
// (FORGE_PROVIDER §1). Left unmerged, their churn and ownership are split
// across rows, which understates bus-factor risk — the one number this product
// exists to get right.
//
// Merges are NON-DESTRUCTIVE and REVERSIBLE (DATABASE.md §2): the row stays and
// `merged_into_id` points at the survivor. Deleting the loser would destroy the
// commit attribution that made the merge worth doing, and could not be undone
// when someone merges the wrong pair.

export interface IdentityRoutesOptions {
  db: Database;
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

export default async function identityRoutes(
  app: FastifyInstance,
  opts: IdentityRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /admin/identities — every identity in the workspace, with its weight. */
  app.get('/admin/identities', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    // Counts come from the facts tables rather than a cached column: an
    // identity with no commits and no PRs is exactly the row an admin is
    // looking for when tidying up, and a stale counter would hide it.
    // Counts come from two grouped reads joined in JS, NOT a correlated
    // subquery. The subquery form was written first and silently returned 0 for
    // every identity: drizzle's `${facts.commits}` interpolation inside sql``
    // does not correlate against the outer `identities` row the way the
    // hand-written equivalent does — verified side by side, the literal form
    // returned 1 and the interpolated one 0 on the same row. Two small
    // workspace-scoped reads are also easier to reason about than SQL whose
    // rendering has to be trusted.
    const rows = await db
      .select({
        id: core.identities.id,
        provider: core.identities.provider,
        login: core.identities.forgeLogin,
        displayName: core.identities.displayName,
        userId: core.identities.userId,
        isBot: core.identities.isBot,
        mergedIntoId: core.identities.mergedIntoId,
      })
      .from(core.identities)
      .where(eq(core.identities.workspaceId, workspaceId))
      .orderBy(core.identities.forgeLogin);

    const commitCounts = await db
      .select({ identityId: facts.commits.authorIdentityId, n: sql<number>`count(*)::int` })
      .from(facts.commits)
      .where(eq(facts.commits.workspaceId, workspaceId))
      .groupBy(facts.commits.authorIdentityId);
    const prCounts = await db
      .select({ identityId: facts.pullRequests.authorIdentityId, n: sql<number>`count(*)::int` })
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.workspaceId, workspaceId))
      .groupBy(facts.pullRequests.authorIdentityId);
    const commitsBy = new Map(commitCounts.map((c) => [c.identityId, c.n]));
    const prsBy = new Map(prCounts.map((c) => [c.identityId, c.n]));

    return reply.send({
      items: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        login: r.login,
        display_name: r.displayName,
        user_id: r.userId,
        is_bot: r.isBot,
        merged_into_id: r.mergedIntoId,
        // An identity with zero of both is exactly the row an admin is looking
        // for when tidying up, so absent counts render as 0, not as missing.
        commits: commitsBy.get(r.id) ?? 0,
        prs: prsBy.get(r.id) ?? 0,
        // An identity whose login looks like an address is the email fallback
        // (DATABASE.md identities note) — surfaced so an admin can tell "this
        // is a person we could not resolve" from "this is a real account".
        email_fallback: r.login.includes('@'),
      })),
    });
  });

  /** PATCH /admin/identities/:id — flag or unflag a bot. */
  app.patch<{ Params: { id: string }; Body: { is_bot?: unknown } }>(
    '/admin/identities/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid identity id');
      const isBot = request.body?.is_bot;
      if (typeof isBot !== 'boolean') {
        return fail(request, reply, 400, 'Invalid body', 'is_bot must be true or false');
      }

      const [before] = await db
        .select({ isBot: core.identities.isBot, login: core.identities.forgeLogin })
        .from(core.identities)
        .where(and(eq(core.identities.id, id), eq(core.identities.workspaceId, workspaceId)))
        .limit(1);
      // Tenancy (Law 5): an identity in another workspace is a 404, never a 403.
      if (!before) return fail(request, reply, 404, 'Identity not found');

      await db
        .update(core.identities)
        .set({ isBot })
        .where(and(eq(core.identities.id, id), eq(core.identities.workspaceId, workspaceId)));

      auditLog(request.log, {
        event: 'identity.bot_flagged',
        actorUserId: request.session.get('userId') ?? null,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        identityId: id,
        login: before.login,
        fromIsBot: before.isBot,
        toIsBot: isBot,
      });

      return reply.send({ id, is_bot: isBot });
    },
  );

  /**
   * POST /admin/identities/:id/merge — fold this identity into another.
   * `{ into_id: null }` reverses a previous merge.
   */
  app.post<{ Params: { id: string }; Body: { into_id?: unknown } }>(
    '/admin/identities/:id/merge',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid identity id');

      const intoRaw = request.body?.into_id;
      const undo = intoRaw === null;
      const intoId = undo ? null : Number(intoRaw);
      if (!undo && !Number.isInteger(intoId)) {
        return fail(
          request,
          reply,
          400,
          'Invalid body',
          'into_id must be an identity id, or null to undo',
        );
      }
      if (!undo && intoId === id) {
        return fail(request, reply, 400, 'Cannot merge an identity into itself');
      }

      const [source] = await db
        .select({
          id: core.identities.id,
          login: core.identities.forgeLogin,
          mergedIntoId: core.identities.mergedIntoId,
        })
        .from(core.identities)
        .where(and(eq(core.identities.id, id), eq(core.identities.workspaceId, workspaceId)))
        .limit(1);
      if (!source) return fail(request, reply, 404, 'Identity not found');

      let target: { id: number; login: string; mergedIntoId: number | null } | undefined;
      if (!undo) {
        [target] = await db
          .select({
            id: core.identities.id,
            login: core.identities.forgeLogin,
            mergedIntoId: core.identities.mergedIntoId,
          })
          .from(core.identities)
          .where(
            and(
              eq(core.identities.id, intoId as number),
              eq(core.identities.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        if (!target) return fail(request, reply, 404, 'Target identity not found');

        // Anything already merged INTO this one would be orphaned behind a
        // second hop, and the readers resolve exactly one (COALESCE, not a
        // recursive CTE). Refused rather than silently producing an identity
        // whose churn disappears from every screen.
        const [dependent] = await db
          .select({ id: core.identities.id })
          .from(core.identities)
          .where(
            and(eq(core.identities.workspaceId, workspaceId), eq(core.identities.mergedIntoId, id)),
          )
          .limit(1);
        if (dependent) {
          return fail(
            request,
            reply,
            409,
            'Identity is a merge target',
            'Other identities are merged into this one. Undo those merges first, or merge them into the same survivor.',
          );
        }
      }

      // Chains are kept flat at WRITE time: merging into an already-merged
      // identity resolves to its survivor. The alternative is a recursive read
      // on the hottest query in the product (every churn/ownership row).
      const resolvedTarget = undo ? null : (target!.mergedIntoId ?? target!.id);

      await db
        .update(core.identities)
        .set({ mergedIntoId: resolvedTarget })
        .where(and(eq(core.identities.id, id), eq(core.identities.workspaceId, workspaceId)));

      auditLog(request.log, {
        event: undo ? 'identity.merge_undone' : 'identity.merged',
        actorUserId: request.session.get('userId') ?? null,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        identityId: id,
        login: source.login,
        fromMergedIntoId: source.mergedIntoId,
        toMergedIntoId: resolvedTarget,
      });

      return reply.send({ id, merged_into_id: resolvedTarget });
    },
  );

  /** GET /admin/identities/unmerged — convenience: candidates worth a look. */
  app.get('/admin/identities/candidates', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    // Email-fallback rows and identities sharing a display name are the two
    // cheap signals. NOT auto-merged: a wrong merge silently rewrites history
    // on every screen, so this suggests and a human decides.
    const rows = await db
      .select({
        id: core.identities.id,
        login: core.identities.forgeLogin,
        displayName: core.identities.displayName,
      })
      .from(core.identities)
      .where(
        and(
          eq(core.identities.workspaceId, workspaceId),
          isNull(core.identities.mergedIntoId),
          or(sql`${core.identities.forgeLogin} like '%@%'`, sql`true`),
        ),
      );

    const byName = new Map<string, { id: number; login: string }[]>();
    for (const r of rows) {
      const key = r.displayName.trim().toLowerCase();
      if (!key) continue;
      (byName.get(key) ?? byName.set(key, []).get(key)!).push({ id: r.id, login: r.login });
    }
    const groups = [...byName.entries()]
      .filter(([, members]) => members.length > 1)
      .map(([displayName, members]) => ({ display_name: displayName, members }));

    return reply.send({ groups });
  });
}
