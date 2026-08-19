import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, plans, read, type Database } from '@repopulse/shared';
import { buildPulse, computeMetricTrend } from '@repopulse/insights';
import { readMetricTrend } from '@repopulse/metrics';
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

  // GET /org/pulse — the deterministic weekly narrative (W6-06, R-A7).
  //
  // Computed from snapshots here, not by a model. A Tier-2 pass may reword it
  // later (pass_kind='narrate'), but the numbers are settled before any model
  // sees them — a narrative that invents "coverage improved 12%" is worse than
  // none, because it is wrong in the register people quote.
  app.get<{ Querystring: { window?: string } }>('/org/pulse', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const window = request.query.window ?? '30d';

    const PULSE_METRICS: { key: string; label: string; higherBetter: boolean; unit: 'ratio' | 'count' | 'hours' }[] = [
      { key: 'M5', label: 'Review coverage', higherBetter: true, unit: 'ratio' },
      { key: 'M8', label: 'Stale pull requests', higherBetter: false, unit: 'count' },
      { key: 'M9', label: 'CI pass rate', higherBetter: true, unit: 'ratio' },
      { key: 'M4', label: 'Cycle time', higherBetter: false, unit: 'hours' },
    ];

    const deltas = [];
    for (const metric of PULSE_METRICS) {
      // Two points from the SAME series: current and one window back. Reading
      // the previous value from a different window would compare a 7-day figure
      // with a 30-day one and report the difference as movement.
      const series = await readMetricTrend(opts.db, {
        workspaceId,
        repoId: null,
        metricKey: metric.key,
        window,
        limit: 2,
      });
      deltas.push({
        key: metric.key,
        label: metric.label,
        current: series[0] ? Number(series[0].value) : null,
        previous: series[1] ? Number(series[1].value) : null,
        higherBetter: metric.higherBetter,
        unit: metric.unit,
      });
    }

    const [findingCounts] = await opts.db
      .select({
        open: sql<number>`count(*) filter (where ${read.findings.status} in ('open','confirmed'))::int`,
        recent: sql<number>`count(*) filter (where ${read.findings.firstSeenAt} > now() - interval '7 days')::int`,
      })
      .from(read.findings)
      .where(eq(read.findings.workspaceId, workspaceId));

    const [planVerified] = await opts.db
      .select({ n: sql<number>`count(*)::int` })
      .from(plans.planItemEvents)
      .where(
        and(
          eq(plans.planItemEvents.workspaceId, workspaceId),
          eq(plans.planItemEvents.toStatus, 'done'),
          gte(plans.planItemEvents.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
        ),
      );

    const bullets = buildPulse({
      repoLabel: 'this workspace',
      windowDays: Number(window.replace('d', '')) || 30,
      deltas,
      openFindings: findingCounts?.open ?? 0,
      newFindingsThisWindow: findingCounts?.recent ?? 0,
      planItemsVerified: planVerified?.n ?? 0,
    });

    return reply.send({
      bullets,
      // Provenance chip (R-D3). 'template' until a narrate pass runs — the card
      // must never imply a model wrote something it did not.
      provenance: 'template',
      window,
    });
  });
}
