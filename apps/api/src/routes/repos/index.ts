import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, facts, type Database } from '@repopulse/shared';
import { rankHotspots } from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';
import { repoHealth } from '../org/health.js';

// Drill-down levels 1–2 (FR-API-5, API_DESIGN §2 'repos'). Warehouse-only.
// Every level returns `links` to its children so a client can walk
// org → repo → prs → files without hardcoding paths.

export interface ReposRoutesOptions {
  db: Database;
}

const WINDOW_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const windowQuery = z.object({ window: z.enum(['7d', '30d', '90d', '365d']).default('30d') });
const idParams = z.object({ id: z.coerce.number().int().positive() });

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title);
  return reply;
}

function repoLinks(id: number): Record<string, string> {
  return {
    self: `/api/v1/repos/${id}`,
    prs: `/api/v1/repos/${id}/prs`,
    hotspots: `/api/v1/repos/${id}/hotspots`,
    contributors: `/api/v1/repos/${id}/contributors`,
  };
}

async function requireRepo(
  db: Database,
  workspaceId: number,
  id: number,
): Promise<{
  id: number;
  org: string;
  name: string;
  syncStatus: string;
  pushedAt: Date | null;
} | null> {
  const [repo] = await db
    .select({
      id: core.repos.id,
      org: core.repos.org,
      name: core.repos.name,
      syncStatus: core.repos.syncStatus,
      workspaceId: core.repos.workspaceId,
      pushedAt: core.repos.pushedAt,
    })
    .from(core.repos)
    .where(eq(core.repos.id, id))
    .limit(1);
  if (!repo || repo.workspaceId !== workspaceId) return null;
  return repo;
}

export default async function reposRoutes(
  app: FastifyInstance,
  opts: ReposRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // GET /repos — list with health (drill-down level 1).
  typedApp.get('/repos', { schema: { querystring: windowQuery } }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const { window } = request.query;
    const nowMs = Date.now();
    const repos = await db
      .select({
        id: core.repos.id,
        org: core.repos.org,
        name: core.repos.name,
        syncStatus: core.repos.syncStatus,
        pushedAt: core.repos.pushedAt,
      })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, workspaceId));
    const items = await Promise.all(
      repos.map(async (r) => {
        const health = await repoHealth(db, workspaceId, r.id, window, r.pushedAt, nowMs);
        return {
          id: r.id,
          org: r.org,
          name: r.name,
          sync: r.syncStatus,
          health: {
            score: Math.round(health.score),
            letter: health.letter,
            basis: health.tier1Only ? 'Tier-1 only' : 'full',
            delta: null,
          },
          links: repoLinks(r.id),
        };
      }),
    );
    return reply.send({ items });
  });

  // GET /repos/{id} — detail: full score breakdown + sync (level 2).
  typedApp.get(
    '/repos/:id',
    { schema: { params: idParams, querystring: windowQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repo = await requireRepo(db, workspaceId, request.params.id);
      if (!repo) return fail(request, reply, 404, 'Not Found');
      const health = await repoHealth(
        db,
        workspaceId,
        repo.id,
        request.query.window,
        repo.pushedAt,
        Date.now(),
      );
      return reply.send({
        id: repo.id,
        org: repo.org,
        name: repo.name,
        sync: repo.syncStatus,
        health: {
          score: Math.round(health.score),
          letter: health.letter,
          basis: health.tier1Only ? 'Tier-1 only' : 'full',
          breakdown: health.subScores,
        },
        links: repoLinks(repo.id),
      });
    },
  );

  // GET /repos/{id}/hotspots — ranked files for this repo (FR-METRICS-2).
  typedApp.get(
    '/repos/:id/hotspots',
    { schema: { params: idParams, querystring: windowQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repo = await requireRepo(db, workspaceId, request.params.id);
      if (!repo) return fail(request, reply, 404, 'Not Found');
      const ranked = await rankHotspots(db, {
        repoIds: [repo.id],
        asOf: new Date(),
        windowDays: WINDOW_DAYS[request.query.window] ?? 30,
        topN: 50,
      });
      return reply.send({
        items: ranked.map((h) => ({
          path: h.path,
          hotspot_score: h.score,
          decomposition: {
            gross: h.gross,
            normChurn: h.normChurn,
            daysSince: h.daysSince,
            decay: h.decay,
          },
          links: { file: `/api/v1/repos/${repo.id}/files/${encodeURIComponent(h.path)}` },
        })),
      });
    },
  );

  // GET /repos/{id}/contributors — churn share per identity (FR-METRICS-3).
  typedApp.get(
    '/repos/:id/contributors',
    { schema: { params: idParams } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repo = await requireRepo(db, workspaceId, request.params.id);
      if (!repo) return fail(request, reply, 404, 'Not Found');
      const rows = await db
        .select({
          login: core.identities.forgeLogin,
          lines: sql<number>`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
        })
        .from(facts.commitFiles)
        .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
        .innerJoin(core.identities, eq(facts.commits.authorIdentityId, core.identities.id))
        .where(and(eq(facts.commits.repoId, repo.id), eq(facts.commits.isMerge, false)))
        .groupBy(core.identities.forgeLogin)
        .orderBy(desc(sql`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})`));
      const total = rows.reduce((s, r) => s + (r.lines ?? 0), 0);
      return reply.send({
        items: rows.map((r) => ({
          login: r.login,
          lines_changed: r.lines ?? 0,
          share: total > 0 ? (r.lines ?? 0) / total : 0,
        })),
        bus_factor: rows.length,
      });
    },
  );
}
