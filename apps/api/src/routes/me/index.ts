import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, facts, type Database } from '@repopulse/shared';
import { identity } from '@repopulse/auth';
import { prSizeBucket } from '@repopulse/metrics';
import { sendProblem } from '../../lib/problem.js';

// Personalized widgets (FR-AUTH-6, FR-WEB-7). Each resolves the logged-in user
// → their forge author identity (identity map) and filters warehouse rows by
// it. A user with no ingested authorship yet resolves to null → empty results
// (never an error). N-9: person-grain data is the caller's OWN only (D6).

export interface MeRoutesOptions {
  db: Database;
}

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title);
  return reply;
}

export default async function meRoutes(app: FastifyInstance, opts: MeRoutesOptions): Promise<void> {
  const { db } = opts;

  async function myIdentity(
    request: FastifyRequest,
  ): Promise<{ workspaceId: number; identityId: number | null } | null> {
    const userId = request.session.get('userId');
    const workspaceId = request.workspace?.id;
    if (userId === undefined || workspaceId === undefined) return null;
    const identityId = await identity.resolveUserIdentity(db, workspaceId, userId);
    return { workspaceId, identityId };
  }

  // GET /me/prs — PRs I authored.
  app.get('/me/prs', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ items: [] });
    const rows = await db
      .select({
        number: facts.pullRequests.number,
        title: facts.pullRequests.title,
        repoId: facts.pullRequests.repoId,
        state: facts.pullRequests.state,
        additions: facts.pullRequests.additions,
        deletions: facts.pullRequests.deletions,
        createdAt: facts.pullRequests.createdAt,
        mergedAt: facts.pullRequests.mergedAt,
      })
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.authorIdentityId, ctx.identityId))
      .orderBy(desc(facts.pullRequests.updatedAt));
    return reply.send({
      items: rows.map((p) => ({
        number: p.number,
        title: p.title,
        repo_id: p.repoId,
        state: p.state,
        size_bucket: prSizeBucket(p.additions + p.deletions),
        opened_at: p.createdAt.toISOString(),
        merged_at: p.mergedAt?.toISOString() ?? null,
        links: { self: `/api/v1/repos/${p.repoId}/prs/${p.number}` },
      })),
    });
  });

  // GET /me/review-queue — open PRs awaiting review that I did NOT author (age-sorted).
  app.get('/me/review-queue', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ items: [] });
    const rows = await db
      .select({
        number: facts.pullRequests.number,
        title: facts.pullRequests.title,
        repoId: facts.pullRequests.repoId,
        createdAt: facts.pullRequests.createdAt,
        author: core.identities.forgeLogin,
      })
      .from(facts.pullRequests)
      .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
      .where(
        and(
          eq(facts.pullRequests.workspaceId, ctx.workspaceId),
          eq(facts.pullRequests.state, 'open'),
          ne(facts.pullRequests.authorIdentityId, ctx.identityId),
        ),
      )
      .orderBy(facts.pullRequests.createdAt); // oldest first (age-sorted review load)
    return reply.send({
      items: rows.map((p) => ({
        number: p.number,
        title: p.title,
        repo_id: p.repoId,
        author: p.author,
        opened_at: p.createdAt.toISOString(),
        links: { self: `/api/v1/repos/${p.repoId}/prs/${p.number}` },
      })),
    });
  });

  // GET /me/hotspots — files I own that are hot (my churn share of the file).
  app.get('/me/hotspots', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ items: [] });
    const rows = await db
      .select({
        repoId: facts.commitFiles.repoId,
        path: facts.commitFiles.path,
        myLines: sql<number>`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
      })
      .from(facts.commitFiles)
      .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
      .where(
        and(
          eq(facts.commitFiles.workspaceId, ctx.workspaceId),
          eq(facts.commits.authorIdentityId, ctx.identityId),
          eq(facts.commits.isMerge, false),
        ),
      )
      .groupBy(facts.commitFiles.repoId, facts.commitFiles.path)
      .orderBy(desc(sql`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})`))
      .limit(50);
    return reply.send({
      items: rows.map((r) => ({
        repo_id: r.repoId,
        path: r.path,
        my_lines: r.myLines ?? 0,
        links: { file: `/api/v1/repos/${r.repoId}/files/${encodeURIComponent(r.path)}` },
      })),
    });
  });

  // GET /me/stats — my own PR size/cycle stats (own data only, N-9).
  app.get('/me/stats', async (request, reply) => {
    const ctx = await myIdentity(request);
    if (!ctx) return fail(request, reply, 401, 'No active session');
    if (ctx.identityId === null) return reply.send({ merged_prs: 0, median_size: null });
    const [row] = await db
      .select({
        mergedCount: sql<number>`count(*) filter (where ${facts.pullRequests.mergedAt} is not null)::int`,
        medianSize: sql<
          number | null
        >`percentile_cont(0.5) within group (order by ${facts.pullRequests.additions} + ${facts.pullRequests.deletions}) filter (where ${facts.pullRequests.mergedAt} is not null)`,
      })
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.authorIdentityId, ctx.identityId));
    return reply.send({ merged_prs: row?.mergedCount ?? 0, median_size: row?.medianSize ?? null });
  });
}
