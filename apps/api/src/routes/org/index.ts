import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, facts, plans, read, security, type Database } from '@repopulse/shared';
import { buildPulse, computeMetricTrend } from '@repopulse/insights';
import { computeAiGovernance, computeRangeHeadline, rangeBounds } from '@repopulse/metrics';
import { healthBand } from '@repopulse/shared/health-band';
import { sendProblem } from '../../lib/problem.js';
import { readWorkspaceSettings } from '../../lib/workspace-settings.js';
import { intentsWithStatus } from '../../lib/intent-status.js';
import { latestSnapshotAt, scopedMetrics } from '../../lib/scope-metrics.js';
import { isMeasured, repoHealthMany } from './health.js';
import { collectTopActions, serializeTopActions } from './top-actions.js';

// Org composites (UX §4.a, FR-INSIGHTS-2/3/4, FR-API-2). Warehouse-only —
// snapshots + the W3-11 score/trend, never a forge call. Session-authed.

export interface OrgRoutesOptions {
  db: Database;
}

const windowQuery = z.object({
  window: z.enum(['7d', '14d', '30d', '90d', '365d']).default('30d'),
});
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
// W20-20 (UX_TODO DSH-56). The KPI row also takes a custom `YYYY-MM-DD..YYYY-MM-DD`
// range (`to` inclusive), computed live for exactly those days; every other
// card still reads the preset that covers it.
const summaryQuery = z.object({
  window: z
    .union([
      z.enum(['7d', '14d', '30d', '90d', '365d']),
      z.string().regex(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/),
    ])
    .default('30d'),
  repos: reposCsv,
});

function repoIdsOf(repos: string | undefined): number[] {
  return repos && repos !== 'all' ? repos.split(',').map(Number) : [];
}

/** Suggestions, not a directory: enough for a datalist to be useful. */
const PEOPLE_LIMIT = 500;

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
  typedApp.get(
    '/org/summary',
    { schema: { querystring: summaryQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { window } = request.query;
      const repoIds = repoIdsOf(request.query.repos);
      if (window.includes('..')) {
        // W20-20 (UX_TODO DSH-56): a custom range is computed from the
        // warehouse for exactly those days, and compared with the equally long
        // period right before it. No snapshot is involved, so `as_of` is now.
        const [from, to] = window.split('..') as [string, string];
        const bounds = rangeBounds(from, to);
        if (!bounds) {
          sendProblem(request, reply, 400, 'Invalid date range', {
            detail:
              'Use YYYY-MM-DD..YYYY-MM-DD: a start on or before the end, ending today at the latest, at most 366 days.',
          });
          return reply;
        }
        const { effective } = await readWorkspaceSettings(opts.db, workspaceId);
        const common = { workspaceId, repoIds, botGlobs: effective.botLoginGlobs };
        const current = await computeRangeHeadline(opts.db, { ...common, ...bounds });
        const previous = await computeRangeHeadline(opts.db, { ...common, ...bounds.previous });
        // W21-01: a prior period with nothing in it (from before the synced
        // history) is no comparison for ANY tile. The counts used to read it
        // as 0 ("up from 0") while the rates beside them said "no prior
        // period"; now every tile says the latter.
        const comparable = previous.activity > 0;
        const tiles = KPI_METRICS.map((metricKey) => {
          const now = current.metrics[metricKey];
          const prev = comparable ? previous.metrics[metricKey].value : null;
          return {
            metric_key: metricKey,
            value: now.value,
            delta: now.value === null || prev === null ? null : now.value - prev,
            previous: prev,
            sample:
              now.numerator !== null && now.denominator !== null && now.denominator > 0
                ? { numerator: now.numerator, denominator: now.denominator }
                : null,
          };
        });
        return reply.send({
          window,
          ...(repoIds.length > 0 ? { repo_ids: repoIds } : {}),
          range: { from, to, days: bounds.days },
          tiles,
          as_of: new Date().toISOString(),
        });
      }
      // W20-09 (UX_TODO DSH-02). A view scoped to three repositories showed the
      // whole workspace's KPIs above three repositories' health tiles. With a
      // repo set the tiles are that set's values — ratios pooled, counts summed
      // (lib/scope-metrics) — and the previous value is the same read one window
      // back, the comparison computeMetricTrend makes for the org series.
      // W20-12 (UX_TODO DSH-81): how many items each ratio tile rests on, read
      // with the same scope rules as the value it sits under.
      const samples = new Map<string, { numerator: number; denominator: number }>();
      const sampleOf = (key: string) => samples.get(key) ?? null;
      // W20-12 (UX_TODO DSH-48): when the newest snapshot in scope was taken,
      // so the page can say "data as of last night" instead of looking live.
      const asOf = await latestSnapshotAt(opts.db, workspaceId, repoIds);
      if (repoIds.length > 0) {
        const windowMs = (Number(window.replace('d', '')) || 30) * 86_400_000;
        const [current, previous] = await Promise.all([
          scopedMetrics(opts.db, workspaceId, repoIds, window, { keys: KPI_METRICS, samples }),
          scopedMetrics(opts.db, workspaceId, repoIds, window, {
            keys: KPI_METRICS,
            asOf: new Date(Date.now() - windowMs),
          }),
        ]);
        const tiles = KPI_METRICS.map((metricKey) => {
          const value = current[metricKey]?.value ?? null;
          const prev = previous[metricKey]?.value ?? null;
          return {
            metric_key: metricKey,
            value,
            delta: value === null || prev === null ? null : value - prev,
            previous: prev,
            sample: sampleOf(metricKey),
          };
        });
        return reply.send({ window, repo_ids: repoIds, tiles, as_of: asOf });
      }
      await scopedMetrics(opts.db, workspaceId, [], window, { keys: KPI_METRICS, samples });
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
            sample: sampleOf(metricKey),
          };
        }),
      );
      return reply.send({ window, tiles, as_of: asOf });
    },
  );

  // GET /org/people — the logins the topbar's person filter suggests (W20-20,
  // UX_TODO DSH-63). People, not accounts: canonical (unmerged), non-bot
  // identities of this workspace that authored a pull request, which is what
  // the filter narrows (`author`). Logins only — the PR list shows them anyway.
  typedApp.get('/org/people', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const rows = await opts.db
      .selectDistinct({ login: core.identities.forgeLogin })
      .from(core.identities)
      .innerJoin(facts.pullRequests, eq(facts.pullRequests.authorIdentityId, core.identities.id))
      .where(
        and(
          eq(core.identities.workspaceId, workspaceId),
          eq(facts.pullRequests.workspaceId, workspaceId),
          eq(core.identities.isBot, false),
          isNull(core.identities.mergedIntoId),
        ),
      )
      .orderBy(core.identities.forgeLogin)
      .limit(PEOPLE_LIMIT);
    return reply.send({ items: rows.map((r) => r.login) });
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
      // W20-20 (UX_TODO DSH-18): the same score from the snapshots one window
      // back, for the tile's change. Since W20-24 the earlier reading takes
      // security findings as they were then (first seen by that date, with the
      // status their history gives for it), not today's in both readings.
      const windowMs = (Number(window.replace('d', '')) || 30) * 86_400_000;
      const before = await repoHealthMany(
        opts.db,
        workspaceId,
        repos,
        window,
        nowMs,
        new Date(nowMs - windowMs),
      );
      const tiles = repos.map((r) => {
        const health = healths.get(r.id)!;
        const prior = before.get(r.id);
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
            // W20-12 (UX_TODO DSH-19): which parts of the score were not
            // measured, so the tile can say so in words the repo page uses.
            not_measured: health.notMeasured.map((n) => n.key),
            delta:
              measured && prior && isMeasured(prior)
                ? Math.round(health.score) - Math.round(prior.score)
                : null,
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

      // W20-24 (UX_TODO DSH-37): file intents whose promise has lapsed — a
      // refactor whose hotspot has not come down by its review date, or a
      // supervised file that got hotter. From insights' intentWarnings over
      // the stored score history; acknowledged files never appear.
      const repoById = new Map(repos.map((r) => [r.id, r]));
      const intents = (await intentsWithStatus(opts.db, workspaceId, repoIds, new Date(nowMs)))
        .filter((i) => repoById.has(i.repoId))
        .flatMap((i) =>
          i.status.warnings.map((w) => ({
            kind: w.kind,
            repo_id: i.repoId,
            org: repoById.get(i.repoId)!.org,
            name: repoById.get(i.repoId)!.name,
            path: i.path,
            intent: i.intent,
            since: i.createdAt.toISOString(),
            from: w.from,
            to: w.to,
            ...(w.kind === 'refactor_stalled' ? { months: w.months } : {}),
          })),
        )
        // Longest-standing first, then by file, so the order is stable.
        .sort((a, b) => a.since.localeCompare(b.since) || a.path.localeCompare(b.path));

      return reply.send({ items, intents });
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
  //
  // W20-09 (UX_TODO DSH-02): `repos` narrows it to a view's repositories —
  // findings in those repositories, and items of plans made for exactly them.
  typedApp.get(
    '/org/top-actions',
    { schema: { querystring: z.object({ repos: reposCsv }) } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoIds = repoIdsOf(request.query.repos);
      const result = await collectTopActions(opts.db, workspaceId, { repoIds });
      return reply.send(serializeTopActions(result));
    },
  );

  // GET /org/pulse — the deterministic weekly narrative (W6-06, R-A7).
  //
  // Computed from snapshots here, not by a model. A Tier-2 pass may reword it
  // later (pass_kind='narrate'), but the numbers are settled before any model
  // sees them — a narrative that invents "coverage improved 12%" is worse than
  // none, because it is wrong in the register people quote.
  //
  // W20-09 (UX_TODO DSH-02): `repos` narrows every number to a view's
  // repositories — the metric deltas through the same set reader the KPI row
  // uses, the finding counts by repository, and verified plan items to plans
  // for exactly that set.
  typedApp.get(
    '/org/pulse',
    { schema: { querystring: repoScopedQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { window } = request.query;
      const repoIds = repoIdsOf(request.query.repos);
      const windowDays = Number(window.replace('d', '')) || 30;

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
      if (repoIds.length > 0) {
        const keys = PULSE_METRICS.map((m) => m.key);
        const windowMs = (Number(window.replace('d', '')) || 30) * 86_400_000;
        const [current, previous] = await Promise.all([
          scopedMetrics(opts.db, workspaceId, repoIds, window, { keys }),
          scopedMetrics(opts.db, workspaceId, repoIds, window, {
            keys,
            asOf: new Date(Date.now() - windowMs),
          }),
        ]);
        for (const metric of PULSE_METRICS) {
          deltas.push({
            key: metric.key,
            label: metric.label,
            current: current[metric.key]?.value ?? null,
            previous: previous[metric.key]?.value ?? null,
            higherBetter: metric.higherBetter,
            unit: metric.unit,
          });
        }
      }
      for (const metric of repoIds.length > 0 ? [] : PULSE_METRICS) {
        // W20-20 (UX_TODO DSH-74): the same comparison as the KPI tile above
        // it — the latest value against the one a full window earlier. This
        // read the two newest snapshots, last night's and the night before,
        // so "improved by 2%" was a one-day change beside a tile showing the
        // change over the window.
        const trend = await computeMetricTrend(opts.db, {
          workspaceId,
          repoId: null,
          metricKey: metric.key,
          window,
        });
        deltas.push({
          key: metric.key,
          label: metric.label,
          current: trend.current,
          previous: trend.previous,
          higherBetter: metric.higherBetter,
          unit: metric.unit,
        });
      }

      const [findingCounts] = await opts.db
        .select({
          open: sql<number>`count(*) filter (where ${read.findings.status} in ('open','confirmed'))::int`,
          // W20-20 (UX_TODO DSH-51): "raised this window" counts the window,
          // not a fixed seven days.
          // windowDays is an integer from the window enum, bound as a parameter
          // (a Date bound inside raw sql is not serialised by the driver).
          recent: sql<number>`count(*) filter (where ${read.findings.firstSeenAt} > now() - make_interval(days => ${windowDays}::int))::int`,
        })
        .from(read.findings)
        .where(
          and(
            eq(read.findings.workspaceId, workspaceId),
            repoIds.length > 0 ? inArray(read.findings.repoId, repoIds) : undefined,
            // W20-20 (UX_TODO DSH-77): rules in trial are not headline findings.
            eq(read.findings.experimental, false),
          ),
        );

      // W20-16 (UX_TODO DSH-84): has any scan finished in this scope? Zero
      // open findings before the first scan is "not measured".
      const [scanned] = await opts.db
        .select({ id: security.scanRuns.id })
        .from(security.scanRuns)
        .where(
          and(
            eq(security.scanRuns.workspaceId, workspaceId),
            eq(security.scanRuns.status, 'succeeded'),
            repoIds.length > 0 ? inArray(security.scanRuns.repoId, repoIds) : undefined,
          ),
        )
        .limit(1);

      const [planVerified] = await opts.db
        .select({ n: sql<number>`count(*)::int` })
        .from(plans.planItemEvents)
        .innerJoin(plans.planItems, eq(plans.planItems.id, plans.planItemEvents.planItemId))
        .innerJoin(plans.improvementPlans, eq(plans.improvementPlans.id, plans.planItems.planId))
        .where(
          and(
            eq(plans.planItemEvents.workspaceId, workspaceId),
            eq(plans.improvementPlans.workspaceId, workspaceId),
            eq(plans.planItemEvents.toStatus, 'done'),
            gte(plans.planItemEvents.createdAt, new Date(Date.now() - windowDays * 86_400_000)),
            // Normalised on write (normalizeRepoIds), so array equality is the
            // same scope comparison the Plans page makes.
            repoIds.length > 0
              ? sql`${plans.improvementPlans.repoIds} = ${sql.raw(`ARRAY[${[...repoIds].sort((a, b) => a - b).join(',')}]::bigint[]`)}`
              : undefined,
          ),
        );

      const bullets = buildPulse({
        repoLabel: repoIds.length > 0 ? 'these repositories' : 'this workspace',
        windowDays,
        deltas,
        openFindings: findingCounts?.open ?? 0,
        newFindingsThisWindow: findingCounts?.recent ?? 0,
        planItemsVerified: planVerified?.n ?? 0,
        scansCompleted: scanned !== undefined,
      });

      return reply.send({
        bullets,
        // Provenance chip (R-D3). 'template' until a narrate pass runs — the card
        // must never imply a model wrote something it did not.
        provenance: 'template',
        window,
        // W20-20 (UX_TODO DSH-51/74): what every change is measured against.
        compared_with: `the value ${windowDays} days earlier`,
      });
    },
  );
}
