import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, facts, type Database } from '@repopulse/shared';
import { sendProblem } from '../../lib/problem.js';

// File detail (FR-API-5, API_DESIGN §2): churn series + owners + hotspot
// history for one path. Path can contain slashes → wildcard route param.

export interface FilesRoutesOptions {
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

async function ownsRepo(db: Database, workspaceId: number, id: number): Promise<boolean> {
  const [r] = await db
    .select({ w: core.repos.workspaceId })
    .from(core.repos)
    .where(eq(core.repos.id, id))
    .limit(1);
  return !!r && r.w === workspaceId;
}

export default async function filesRoutes(
  app: FastifyInstance,
  opts: FilesRoutesOptions,
): Promise<void> {
  const { db } = opts;

  app.get<{ Params: { id: string; '*': string } }>('/repos/:id/files/*', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.id);
    if (!Number.isInteger(repoId) || !(await ownsRepo(db, workspaceId, repoId)))
      return fail(request, reply, 404, 'Not Found');
    const path = request.params['*'];

    // Per-commit churn series for the file (non-merge commits).
    const series = await db
      .select({
        sha: facts.commits.sha,
        authoredAt: facts.commits.authoredAt,
        additions: facts.commitFiles.additions,
        deletions: facts.commitFiles.deletions,
      })
      .from(facts.commitFiles)
      .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
      .where(
        and(
          eq(facts.commitFiles.repoId, repoId),
          eq(facts.commitFiles.path, path),
          eq(facts.commits.isMerge, false),
        ),
      )
      .orderBy(asc(facts.commits.authoredAt));

    // Owners by lines changed.
    const owners = await db
      .select({
        login: core.identities.forgeLogin,
        lines: sql<number>`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
      })
      .from(facts.commitFiles)
      .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
      .innerJoin(core.identities, eq(facts.commits.authorIdentityId, core.identities.id))
      .where(
        and(
          eq(facts.commitFiles.repoId, repoId),
          eq(facts.commitFiles.path, path),
          eq(facts.commits.isMerge, false),
        ),
      )
      .groupBy(core.identities.forgeLogin)
      .orderBy(desc(sql`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})`));

    if (series.length === 0) return fail(request, reply, 404, 'Not Found');
    const totalLines = owners.reduce((s, o) => s + (o.lines ?? 0), 0);
    return reply.send({
      path,
      churn_series: series.map((c) => ({
        sha: c.sha,
        authored_at: c.authoredAt.toISOString(),
        additions: c.additions,
        deletions: c.deletions,
      })),
      owners: owners.map((o) => ({
        login: o.login,
        lines_changed: o.lines ?? 0,
        share: totalLines > 0 ? (o.lines ?? 0) / totalLines : 0,
      })),
      links: { repo: `/api/v1/repos/${repoId}` },
    });
  });
}
