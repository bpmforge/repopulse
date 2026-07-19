import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, type Database } from '@repopulse/shared';
import { computeMetricTrend } from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';
import { repoHealth } from './health.js';

// Org composites (UX §4.a, FR-INSIGHTS-2/3/4, FR-API-2). Warehouse-only —
// snapshots + the W3-11 score/trend, never a forge call. Session-authed.

export interface OrgRoutesOptions {
  db: Database;
}

const windowQuery = z.object({ window: z.enum(['7d', '30d', '90d', '365d']).default('30d') });
const attentionQuery = windowQuery.extend({ since: z.string().optional() });

// The 5 KPI tiles (dashboard landing). Org-rollup series (repoId null).
const KPI_METRICS = ['M5', 'M9', 'M4', 'M1', 'M10'] as const;

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title);
  return reply;
}

export default async function orgRoutes(
  app: FastifyInstance,
  opts: OrgRoutesOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // GET /org/summary — 5 KPI tile values with deltas (FR-INSIGHTS-4).
  typedApp.get('/org/summary', { schema: { querystring: windowQuery } }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const { window } = request.query;
    const tiles = await Promise.all(
      KPI_METRICS.map(async (metricKey) => {
        const trend = await computeMetricTrend(opts.db, {
          workspaceId,
          repoId: null,
          metricKey,
          window,
        });
        return { metric_key: metricKey, value: trend.current, delta: trend.delta };
      }),
    );
    return reply.send({ window, tiles });
  });

  // GET /org/health-tiles — per-repo health grid (FR-INSIGHTS-2/3).
  typedApp.get(
    '/org/health-tiles',
    { schema: { querystring: windowQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { window } = request.query;
      const nowMs = Date.now();
      const repos = await opts.db
        .select({ id: core.repos.id, name: core.repos.name, pushedAt: core.repos.pushedAt })
        .from(core.repos)
        .where(eq(core.repos.workspaceId, workspaceId));

      const tiles = await Promise.all(
        repos.map(async (r) => {
          const health = await repoHealth(opts.db, workspaceId, r.id, window, r.pushedAt, nowMs);
          return {
            id: r.id,
            name: r.name,
            health: {
              score: Math.round(health.score),
              letter: health.letter,
              basis: health.tier1Only ? 'Tier-1 only' : 'full',
              // delta needs a prior health snapshot series — a later enrichment.
              delta: null,
            },
          };
        }),
      );
      return reply.send({ items: tiles });
    },
  );

  // GET /org/attention — change items since the client's last visit (UX §4.a).
  // MVP: repos whose health band would draw attention (C/D/E) at the `since`
  // point; the full since-diff (new stale PRs, CI regressions, unreviewed
  // merges) enriches once those event streams exist (W4/W6).
  typedApp.get(
    '/org/attention',
    { schema: { querystring: attentionQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { window } = request.query;
      const nowMs = Date.now();
      const repos = await opts.db
        .select({ id: core.repos.id, name: core.repos.name, pushedAt: core.repos.pushedAt })
        .from(core.repos)
        .where(eq(core.repos.workspaceId, workspaceId));

      const items = [];
      for (const r of repos) {
        const health = await repoHealth(opts.db, workspaceId, r.id, window, r.pushedAt, nowMs);
        if (['C', 'D', 'E'].includes(health.letter)) {
          items.push({ repo_id: r.id, name: r.name, kind: 'health_band', band: health.letter });
        }
      }
      return reply.send({ items });
    },
  );
}
