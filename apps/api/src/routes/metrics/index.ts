import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '@repopulse/shared';
import { METRIC_CATALOG, readMetricTrend } from '@repopulse/metrics';
import { computeMetricTrend } from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';

// Metrics read API (FR-METRICS-13/14/15, FR-API-2). Warehouse-only — every
// handler reads Postgres (snapshots) and NEVER a forge API (C1). This module
// must not import @repopulse/forge (validate-arch + the nock-guard test enforce
// it). Session-authed (child of apiV1).

export interface MetricsRoutesOptions {
  db: Database;
}

const seriesQuery = z.object({
  metric_key: z.string(),
  window: z.enum(['7d', '30d', '90d', '365d']).default('30d'),
  repo_id: z.coerce.number().int().positive().optional(),
});

function toNum(v: string | null): number | null {
  return v === null ? null : Number(v);
}

const WINDOW_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

/**
 * The snapshots that fall inside the selected window (W20-12, UX_TODO DSH-75).
 *
 * The series returned up to 400 nightly rows whatever the window, so a chart
 * labelled "last 7d" drew about thirteen months, and changing the window only
 * changed how smooth that year looked. It now spans one window ending at the
 * newest snapshot, plus the newest row at or before the window's start: the
 * same baseline computeMetricTrend compares a KPI tile's delta against, so the
 * line starts where the tile's "versus prior window" starts.
 *
 * Anchored on the newest snapshot, not the wall clock, so a workspace whose
 * nightly job stalled still shows its last window rather than an empty chart.
 */
export function pointsInWindow<T extends { computedAt: Date }>(
  newestFirst: readonly T[],
  window: string,
): T[] {
  const newest = newestFirst[0];
  if (!newest) return [];
  const cutoff = newest.computedAt.getTime() - (WINDOW_DAYS[window] ?? 30) * 86_400_000;
  const inside = newestFirst.filter((r) => r.computedAt.getTime() > cutoff);
  const baseline = newestFirst.find((r) => r.computedAt.getTime() <= cutoff);
  return baseline ? [...inside, baseline] : inside;
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

export default async function metricsRoutes(
  app: FastifyInstance,
  opts: MetricsRoutesOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // FR-METRICS-15: the catalog UI tooltips + report footnotes read (never hardcode).
  typedApp.get('/metrics/catalog', async (_request, reply) => {
    return reply.send({ items: METRIC_CATALOG });
  });

  // FR-METRICS-13/14: snapshot time-series. repo_id omitted → org rollup series.
  typedApp.get(
    '/metrics/series',
    { schema: { querystring: seriesQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { metric_key, window, repo_id } = request.query;

      const rows = await readMetricTrend(opts.db, {
        workspaceId,
        repoId: repo_id ?? null,
        metricKey: metric_key,
        window,
        limit: 400, // ≥400d retention (FR-METRICS-13)
      });
      // readMetricTrend is newest-first; a time-series wants oldest-first.
      const points = pointsInWindow(rows, window)
        .reverse()
        .map((r) => ({
          computed_at: r.computedAt.toISOString(),
          value: toNum(r.value),
          numerator: toNum(r.numerator),
          denominator: toNum(r.denominator),
        }));
      const basisLabel = (rows[0]?.dims as { basis?: string } | undefined)?.basis ?? null;
      return reply.send({ points, basis_label: basisLabel });
    },
  );

  // FR-INSIGHTS-4: latest value + delta vs the previous equal-length window.
  typedApp.get(
    '/metrics/current',
    { schema: { querystring: seriesQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { metric_key, window, repo_id } = request.query;
      const trend = await computeMetricTrend(opts.db, {
        workspaceId,
        repoId: repo_id ?? null,
        metricKey: metric_key,
        window,
      });
      return reply.send(trend);
    },
  );
}
