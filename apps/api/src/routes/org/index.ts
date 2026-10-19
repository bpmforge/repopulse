import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, plans, read, type Database } from '@repopulse/shared';
import { buildPulse, computeMetricTrend } from '@repopulse/insights';
import { computeAiGovernance, readMetricTrend } from '@repopulse/metrics';
import { healthBand } from '@repopulse/shared/health-band';
import { sendProblem } from '../../lib/problem.js';
import { isMeasured, repoHealthMany } from './health.js';
import { collectTopActions, serializeTopActions } from './top-actions.js';

// Org composites (UX §4.a, FR-INSIGHTS-2/3/4, FR-API-2). Warehouse-only —
// snapshots + the W3-11 score/trend, never a forge call. Session-authed.

export interface OrgRoutesOptions {
  db: Database;
}

const windowQuery = z.object({ window: z.enum(['7d', '30d', '90d', '365d']).default('30d') });
// The global filter's `repos` csv (or `all`).
const reposCsv = z
  .string()
  .regex(/^(all|\d+(,\d+)*)$/)
  .optional();
// W18-20. There is deliberately no `person`: the governance view is
// aggregate-only (N-9), and accepting the global person filter would turn it
// into a per-developer AI-usage report.
const governanceQuery = windowQuery.extend({ repos: reposCsv });
// W20-05 (UX_TODO DSH-02). The health grid and the attention feed take the
// same `repos` csv, so a saved view scoped to three repositories shows those
// three rather than the whole workspace. `since` is gone: the feed never read
// it (DSH-09), and accepting it implied a diff that did not exist.
const repoScopedQuery = windowQuery.extend({ repos: reposCsv });

function repoIdsOf(repos: string | undefined): number[] {
  return repos && repos !== 'all' ? repos.split(',').map(Number) : [];
}

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
        // `previous` travels with the delta (W16-56). The tile shows a PERCENT
        // change, and an absolute delta cannot be turned into one without the
        // baseline — so the web was rendering "−373" as "−373%", a fall of more
        // than everything there was.
        return {
          metric_key: metricKey,
          value: trend.current,
          delta: trend.delta,
          previous: trend.previous,
        };
      }),
    );
    return reply.send({ window, tiles });
  });

  // GET /org/health-tiles — per-repo health grid (FR-INSIGHTS-2/3).
  typedApp.get(
    '/org/health-tiles',
    { schema: { querystring: repoScopedQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { window } = request.query;
      const repoIds = repoIdsOf(request.query.repos);
      const nowMs = Date.now();
      const repos = await opts.db
        .select({
          id: core.repos.id,
          org: core.repos.org,
          name: core.repos.name,
          pushedAt: core.repos.pushedAt,
        })
        .from(core.repos)
        .where(
          and(
            eq(core.repos.workspaceId, workspaceId),
            repoIds.length > 0 ? inArray(core.repos.id, repoIds) : undefined,
          ),
        );

      // One batched read for every repo (W17-32), not one loader call per row.
      const healths = await repoHealthMany(opts.db, workspaceId, repos, window, nowMs);
      const tiles = repos.map((r) => {
        const health = healths.get(r.id)!;
        // W20-05 (UX_TODO DSH-08). The same `measured` guard /repos applies
        // (W17-18): a repository with no sub-scores sums an empty set to 0, and
        // this grid painted that 0 red as "needs attention" while /repos showed
        // the same repository as "—".
        const measured = isMeasured(health);
        return {
          id: r.id,
          org: r.org,
          name: r.name,
          health: {
            score: measured ? Math.round(health.score) : null,
            letter: measured ? health.letter : null,
            measured,
            basis: measured ? (health.tier1Only ? 'Tier-1 only' : 'full') : 'not measured',
            // delta needs a prior health snapshot series — a later enrichment.
            delta: null,
          },
        };
      });
      // WORST FIRST, unmeasured last (W20-05, UX_TODO X-05): at 500 repositories
      // the card shows the first dozen, and database order put whatever was
      // inserted first there instead of what needs looking at. Name breaks ties
      // so two refreshes cannot reshuffle the grid.
      tiles.sort((a, b) => {
        const sa = a.health.score;
        const sb = b.health.score;
        if (sa === null || sb === null) {
          if (sa === sb) return a.name.localeCompare(b.name);
          return sa === null ? 1 : -1;
        }
        return sa - sb || a.name.localeCompare(b.name);
      });
      return reply.send({ items: tiles });
    },
  );

  // GET /org/attention — repositories below the healthy band (UX §4.a).
  //
  // W20-05 (UX_TODO DSH-09/DSH-10). This used to promise "what changed since
  // your last visit" and ignore `since`, and it banded on the score LETTER
  // (C/D/E) while the badges beside it used the 3-band ramp. It is now what it
  // always actually was — every measured repository scoring below healthy —
  // banded by the same function the badges use. The since-diff (new stale PRs,
  // CI regressions, unreviewed merges) needs event streams that do not exist
  // yet, so it is not claimed.
  typedApp.get(
    '/org/attention',
    { schema: { querystring: repoScopedQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { window } = request.query;
      const repoIds = repoIdsOf(request.query.repos);
      const nowMs = Date.now();
      const repos = await opts.db
        .select({
          id: core.repos.id,
          org: core.repos.org,
          name: core.repos.name,
          pushedAt: core.repos.pushedAt,
        })
        .from(core.repos)
        .where(
          and(
            eq(core.repos.workspaceId, workspaceId),
            repoIds.length > 0 ? inArray(core.repos.id, repoIds) : undefined,
          ),
        );

      const items = [];
      const healths = await repoHealthMany(opts.db, workspaceId, repos, window, nowMs);
      for (const r of repos) {
        const health = healths.get(r.id)!;
        // Unmeasured is not unhealthy (DSH-08): a repository nobody has
        // ingested yet is not something to "attend now".
        if (!isMeasured(health)) continue;
        const score = Math.round(health.score);
        const band = healthBand(score);
        if (band === 'good') continue;
        items.push({ repo_id: r.id, org: r.org, name: r.name, kind: 'health_band', band, score });
      }

      // WORST FIRST (W16-23).
      //
      // This loop followed whatever order Postgres returned — the select has no
      // ORDER BY — so a card called "Needs attention" was not ordered by how
      // much attention anything needed. On the seeded workspace the worst
      // repository (infra, 38) rendered last, and with two hundred repositories
      // the card is one you cannot triage from at all. Worse, without an
      // ORDER BY anywhere the order could differ between two refreshes, so the
      // list could reshuffle under someone mid-read.
      //
      // Name is the tie-break so the result is fully deterministic rather than
      // merely sorted.
      items.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));

      return reply.send({ items });
    },
  );

  // GET /org/ai-governance — AI-authored vs human changes (W18-20).
  //
  // Computed on read from the warehouse, not snapshotted: the classification
  // depends on the admin-editable pattern list, and a stored verdict would keep
  // the old answer after an admin corrected a pattern. Aggregate only — the
  // response carries counts and rates, never a login or a trailer value.
  typedApp.get(
    '/org/ai-governance',
    { schema: { querystring: governanceQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { window, repos } = request.query;
      const repoIds = repoIdsOf(repos);
      const result = await computeAiGovernance(opts.db, {
        workspaceId,
        repoIds,
        windowEnd: new Date(),
        windowDays: Number(window.replace('d', '')),
      });
      return reply.send({ window, ...result });
    },
  );

  // GET /org/top-actions — at most three things worth doing next (W17-16).
  //
  // Deterministic and warehouse-only: findings keep the risk the engine priced
  // them at, plan items keep the rank generatePlanItems() gave them, and no
  // model is asked. An empty list carries coverage state instead of an implied
  // clean bill of health.
  app.get('/org/top-actions', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const result = await collectTopActions(opts.db, workspaceId);
    return reply.send(serializeTopActions(result));
  });

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

    const PULSE_METRICS: {
      key: string;
      label: string;
      higherBetter: boolean;
      unit: 'ratio' | 'count' | 'hours';
    }[] = [
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
