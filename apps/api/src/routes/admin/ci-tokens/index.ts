import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';
import { actorLoginFor } from '../../../lib/actor.js';
import { mintCiToken } from '../../../lib/ci-token.js';

// Admin → CI tokens (W18-18, D16 "CI pull").
//
// ADMIN-ONLY AND AUDITED like every other credential surface (llm-providers,
// connections): a CI token reads findings from outside the product, unattended,
// for as long as it lives.
//
// SHOWN ONCE. The secret is in the 201 body of the create call and nowhere
// else, ever — only its hash is stored, so there is nothing to show again. A
// lost token is revoked and replaced, never recovered.
//
// REVOKE KEEPS THE ROW. Deleting it would erase which token read what; the
// revoked row is the record, and the guard refuses it on the very next request.

export interface CiTokenRoutesOptions {
  db: Database;
}

/** A token outliving a year is a token nobody remembers minting. */
const MAX_EXPIRY_DAYS = 365;
const MAX_REPOS = 100;

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

interface CreateBody {
  name?: unknown;
  repo_ids?: unknown;
  expires_in_days?: unknown;
}

export default async function ciTokenRoutes(
  app: FastifyInstance,
  opts: CiTokenRoutesOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/admin/ci-tokens', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const rows = await db
      .select({
        id: core.ciTokens.id,
        name: core.ciTokens.name,
        prefix: core.ciTokens.tokenPrefix,
        scope: core.ciTokens.scope,
        repoIds: core.ciTokens.repoIds,
        createdByLogin: core.ciTokens.createdByLogin,
        createdAt: core.ciTokens.createdAt,
        expiresAt: core.ciTokens.expiresAt,
        lastUsedAt: core.ciTokens.lastUsedAt,
        revokedAt: core.ciTokens.revokedAt,
      })
      .from(core.ciTokens)
      .where(eq(core.ciTokens.workspaceId, workspaceId))
      .orderBy(desc(core.ciTokens.id));
    return reply.send({
      // The prefix, never the token or its hash — same contract as a forge
      // credential's fingerprint.
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scope: r.scope,
        repo_ids: r.repoIds,
        created_by: r.createdByLogin,
        created_at: r.createdAt.toISOString(),
        expires_at: r.expiresAt?.toISOString() ?? null,
        last_used_at: r.lastUsedAt?.toISOString() ?? null,
        revoked_at: r.revokedAt?.toISOString() ?? null,
      })),
    });
  });

  app.post('/admin/ci-tokens', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session?.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const body = (request.body ?? {}) as CreateBody;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 200) return fail(request, reply, 400, 'A name is required');

    const repoIds = Array.isArray(body.repo_ids) ? body.repo_ids : [];
    if (
      repoIds.length === 0 ||
      repoIds.length > MAX_REPOS ||
      !repoIds.every((r): r is number => Number.isInteger(r) && (r as number) > 0)
    ) {
      return fail(
        request,
        reply,
        400,
        'repo_ids must name at least one repository',
        `A CI token reads only the repositories it names (1-${MAX_REPOS}); there is no "all repositories" token.`,
      );
    }
    const unique = [...new Set(repoIds)];

    let expiresInDays = MAX_EXPIRY_DAYS;
    if (body.expires_in_days !== undefined) {
      const d = body.expires_in_days;
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > MAX_EXPIRY_DAYS) {
        return fail(request, reply, 400, `expires_in_days must be 1-${MAX_EXPIRY_DAYS}`);
      }
      expiresInDays = d;
    }

    // Every named repository must be this workspace's — checked here so a token
    // can never be minted for another tenant's repository id, rather than
    // relying on every reader to re-check.
    const owned = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.workspaceId, workspaceId), inArray(core.repos.id, unique)));
    if (owned.length !== unique.length) {
      return fail(request, reply, 400, 'Unknown repository in repo_ids');
    }

    const minted = mintCiToken();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const actorLogin = await actorLoginFor(db, userId);
    const [row] = await db
      .insert(core.ciTokens)
      .values({
        workspaceId,
        name,
        tokenHash: minted.hash,
        tokenPrefix: minted.displayPrefix,
        scope: 'pr_findings:read',
        repoIds: unique,
        createdBy: userId,
        createdByLogin: actorLogin,
        expiresAt,
      })
      .returning({ id: core.ciTokens.id });

    auditLog(request.log, {
      event: 'ci_token.created',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      detail: {
        ci_token_id: row?.id ?? null,
        name,
        prefix: minted.displayPrefix,
        scope: 'pr_findings:read',
        repo_ids: unique,
        expires_at: expiresAt.toISOString(),
      },
    });

    return reply.code(201).send({
      id: row?.id ?? null,
      name,
      // The ONLY time this value leaves the server.
      token: minted.token,
      prefix: minted.displayPrefix,
      scope: 'pr_findings:read',
      repo_ids: unique,
      expires_at: expiresAt.toISOString(),
    });
  });

  app.delete('/admin/ci-tokens/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session?.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return fail(request, reply, 400, 'Invalid id');

    const [revoked] = await db
      .update(core.ciTokens)
      .set({ revokedAt: new Date(), revokedBy: userId })
      .where(
        and(
          eq(core.ciTokens.id, id),
          eq(core.ciTokens.workspaceId, workspaceId),
          isNull(core.ciTokens.revokedAt),
        ),
      )
      .returning({ name: core.ciTokens.name, prefix: core.ciTokens.tokenPrefix });
    if (!revoked) return fail(request, reply, 404, 'No such active token');

    auditLog(request.log, {
      event: 'ci_token.revoked',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      detail: { ci_token_id: id, name: revoked.name, prefix: revoked.prefix },
    });
    return reply.code(204).send();
  });
}
