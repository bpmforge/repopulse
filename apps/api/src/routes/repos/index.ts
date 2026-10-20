import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, facts, type Database } from '@repopulse/shared';
import { rankHotspots } from '@repopulse/insights';
import {
  computeReviewBotMetrics,
  computeReviewLoad,
  isNonHumanReviewer,
  readMetricTrend,
  readReviewBotInputs,
  type RatioResult,
} from '@repopulse/metrics';
import { connectionHost } from '@repopulse/ingest';
import { sendProblem } from '../../lib/problem.js';
import { isMeasured, repoHealth, repoHealthMany } from '../org/health.js';
import { repoCapabilities } from '../../lib/capability.js';
import { readWorkspaceSettings } from '../../lib/workspace-settings.js';
import { latestSnapshotAt } from '../../lib/scope-metrics.js';

// Drill-down levels 1–2 (FR-API-5, API_DESIGN §2 'repos'). Warehouse-only.
// Every level returns `links` to its children so a client can walk
// org → repo → prs → files without hardcoding paths.

export interface ReposRoutesOptions {
  db: Database;
}

const WINDOW_DAYS: Record<string, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
  '365d': 365,
};
const windowQuery = z.object({
  window: z.enum(['7d', '14d', '30d', '90d', '365d']).default('30d'),
});
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

/**
 * Which forge and host a repository comes from (W20-15, UX_TODO X-16). With
 * GitHub, GitLab and Gitea connected at once, `org/name` alone could not say,
 * and a repository mirrored on two of them showed as two identical rows.
 */
async function forgeOf(
  db: Database,
  workspaceId: number,
  repoIds: number[],
): Promise<Map<number, { provider: string; host: string | null; connection_id: number }>> {
  if (repoIds.length === 0) return new Map();
  const rows = await db
    .select({
      repoId: core.repos.id,
      connectionId: core.forgeConnections.id,
      provider: core.forgeConnections.provider,
      baseUrl: core.forgeConnections.baseUrl,
    })
    .from(core.repos)
    .innerJoin(
      core.forgeConnections,
      and(
        eq(core.forgeConnections.id, core.repos.connectionId),
        eq(core.forgeConnections.workspaceId, workspaceId),
      ),
    )
    .where(and(eq(core.repos.workspaceId, workspaceId), inArray(core.repos.id, repoIds)));
  return new Map(
    rows.map((r) => [
      r.repoId,
      {
        provider: r.provider,
        host: connectionHost(r.provider, r.baseUrl),
        connection_id: r.connectionId,
      },
    ]),
  );
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
  lastSyncedAt: Date | null;
} | null> {
  const [repo] = await db
    .select({
      id: core.repos.id,
      org: core.repos.org,
      name: core.repos.name,
      syncStatus: core.repos.syncStatus,
      workspaceId: core.repos.workspaceId,
      pushedAt: core.repos.pushedAt,
      lastSyncedAt: core.repos.lastSyncedAt,
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
    // One batched read for every repo (W17-32), not one loader call per row.
    const healths = await repoHealthMany(db, workspaceId, repos, window, nowMs);
    const forges = await forgeOf(
      db,
      workspaceId,
      repos.map((r) => r.id),
    );
    // The same org/name tracked through two connections (a Gitea mirror of a
    // GitHub repository) is counted twice in every org metric (X-16).
    const nameCount = new Map<string, number>();
    for (const r of repos) {
      const key = `${r.org}/${r.name}`.toLowerCase();
      nameCount.set(key, (nameCount.get(key) ?? 0) + 1);
    }
    const items = repos.map((r) => {
      const health = healths.get(r.id)!;
      // UNKNOWN is a third state, not a low number (W17-18).
      //
      // computeHealthScore sums contributions, so a repo where every
      // sub-score was dropped for want of inputs sums an EMPTY set to 0 —
      // and scoreLetter(0) is 'E'. Serialized as `{score: 0, letter: 'E'}`
      // that is a verdict the warehouse never reached, and it ranks a repo
      // nobody has ingested below every genuinely unhealthy one. Same
      // discipline the sub-scores themselves already follow: unmeasured is
      // excluded, never scored.
      const measured = isMeasured(health);
      return {
        id: r.id,
        org: r.org,
        name: r.name,
        forge: forges.get(r.id) ?? null,
        tracked_twice: (nameCount.get(`${r.org}/${r.name}`.toLowerCase()) ?? 0) > 1,
        sync: r.syncStatus,
        health: {
          score: measured ? Math.round(health.score) : null,
          // Null together with the score: a letter beside a null score would
          // be the same claim by another name.
          letter: measured ? health.letter : null,
          measured,
          // Not "Tier-1 only" either — there is no tier of evidence here.
          basis: measured ? (health.tier1Only ? 'Tier-1 only' : 'full') : 'not measured',
          delta: null,
        },
        links: repoLinks(r.id),
      };
    });
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
      // W20-05 (UX_TODO DSH-08): the list's `measured` guard, here too. The
      // repo header painted an unmeasured repository's empty-set 0 red while
      // /repos showed the same repository as "—".
      const measured = isMeasured(health);
      const forge = (await forgeOf(db, workspaceId, [repo.id])).get(repo.id) ?? null;
      return reply.send({
        id: repo.id,
        org: repo.org,
        name: repo.name,
        forge,
        sync: repo.syncStatus,
        // W20-12 (UX_TODO DSH-24/48): when the forge was last read and when
        // the numbers on this page were computed — stale data looked current.
        last_synced_at: repo.lastSyncedAt?.toISOString() ?? null,
        as_of: await latestSnapshotAt(db, workspaceId, [repo.id]),
        health: {
          score: measured ? Math.round(health.score) : null,
          letter: measured ? health.letter : null,
          measured,
          basis: measured ? (health.tier1Only ? 'Tier-1 only' : 'full') : 'not measured',
          breakdown: health.subScores,
          // W20-12 (UX_TODO DSH-80): the dropped sub-scores with the weight
          // each would have carried, and whether the rest were rescaled to
          // fill the gap — computed all along and never sent.
          not_measured: health.notMeasured,
          renormalized: health.renormalized,
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
      // W20-12 (UX_TODO DSH-20): each hot file's top owner — the spec's
      // "hotspot 91 · bus factor 1" row — read as the file page reads owners
      // (non-merge lines changed, all history), in one grouped statement for
      // the ranked paths rather than one per file.
      const paths = ranked.map((h) => h.path);
      const ownerRows =
        paths.length === 0
          ? []
          : await db
              .select({
                path: facts.commitFiles.path,
                login: core.identities.forgeLogin,
                lines: sql<number>`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
              })
              .from(facts.commitFiles)
              .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
              .innerJoin(core.identities, eq(facts.commits.authorIdentityId, core.identities.id))
              .where(
                and(
                  eq(facts.commitFiles.workspaceId, workspaceId),
                  eq(facts.commitFiles.repoId, repo.id),
                  inArray(facts.commitFiles.path, paths),
                  eq(facts.commits.isMerge, false),
                ),
              )
              .groupBy(facts.commitFiles.path, core.identities.forgeLogin);
      const owners = new Map<string, { login: string; lines: number; total: number }>();
      for (const row of ownerRows) {
        const cur = owners.get(row.path);
        const lines = row.lines ?? 0;
        if (!cur) owners.set(row.path, { login: row.login, lines, total: lines });
        else {
          cur.total += lines;
          // Ties break on login so two refreshes cannot name different owners.
          if (lines > cur.lines || (lines === cur.lines && row.login < cur.login)) {
            cur.login = row.login;
            cur.lines = lines;
          }
        }
      }
      return reply.send({
        items: ranked.map((h) => ({
          path: h.path,
          hotspot_score: h.score,
          top_owner: ((o) =>
            o ? { login: o.login, share: o.total > 0 ? o.lines / o.total : 0 } : null)(
            owners.get(h.path),
          ),
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

  // GET /repos/{id}/review-load — per-REVIEWER counts (W4-15, UX_SPEC §4.b).
  //
  // The PR list exposes author and a review_covered flag and nothing else, so
  // a review-load matrix built from what was reachable would have rendered
  // plausibly while answering a different question. W4-04 shipped an explicit
  // empty state naming this ticket instead, on a screen whose whole job is
  // evidence.
  typedApp.get(
    '/repos/:id/review-load',
    { schema: { params: idParams, querystring: windowQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repo = await requireRepo(db, workspaceId, request.params.id);
      if (!repo) return fail(request, reply, 404, 'Not Found');

      const days = WINDOW_DAYS[request.query.window] ?? 30;
      const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          reviewerLogin: core.identities.forgeLogin,
          reviewerIsBot: core.identities.isBot,
          state: facts.prReviews.state,
          pullRequestId: facts.prReviews.pullRequestId,
          authorIdentityId: facts.pullRequests.authorIdentityId,
          reviewerIdentityId: facts.prReviews.reviewerIdentityId,
        })
        .from(facts.prReviews)
        .innerJoin(core.identities, eq(facts.prReviews.reviewerIdentityId, core.identities.id))
        .innerJoin(facts.pullRequests, eq(facts.prReviews.pullRequestId, facts.pullRequests.id))
        .where(
          and(
            eq(facts.prReviews.workspaceId, workspaceId),
            eq(facts.prReviews.repoId, repo.id),
            gte(facts.prReviews.submittedAt, windowStart),
          ),
        );

      const load = computeReviewLoad(
        rows.map((r) => ({
          reviewerLogin: r.reviewerLogin,
          state: r.state,
          pullRequestId: r.pullRequestId,
          // Self-review is decided HERE, from the warehouse, rather than being
          // inferred in the browser from two lists that may be filtered
          // differently.
          isSelfReview: r.authorIdentityId === r.reviewerIdentityId,
          // W18-23: the identity flag alone missed `Copilot`, whose login has
          // no [bot] suffix and whose identity row predates the registry.
          isBot: isNonHumanReviewer(r.reviewerLogin, undefined, r.reviewerIsBot),
        })),
      );

      return reply.send({
        window: request.query.window,
        items: load.reviewers.map((r) => ({
          login: r.reviewerLogin,
          prs_reviewed: r.prsReviewed,
          reviews: r.reviews,
          approvals: r.approvals,
          changes_requested: r.changesRequested,
          comments: r.comments,
        })),
        prs_with_review: load.prsWithReview,
        // Surfaced so the screen can state what it left out rather than
        // presenting a filtered number as a total.
        excluded: {
          self_reviews: load.excluded.selfReviews,
          bot_reviews: load.excluded.botReviews,
        },
      });
    },
  );

  // GET /repos/{id}/review-bots — the AI reviewers a team runs (W18-23,
  // METRICS.md §5). Computed live from the warehouse like review-load: the
  // inputs are a window's PRs, reviews and comment anchors, and a snapshot
  // would add a nightly lag to a screen people open right after trying a tool.
  //
  // Tools, not people (N-9): the payload carries no human login and no score.
  // `forge` and `line_data` are here so the screen can say WHY a column is
  // empty — "Gitea does not provide line anchors" is a different fact from
  // "this token was refused" or "not fetched yet", and none of them is zero.
  typedApp.get(
    '/repos/:id/review-bots',
    { schema: { params: idParams, querystring: windowQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repo = await requireRepo(db, workspaceId, request.params.id);
      if (!repo) return fail(request, reply, 404, 'Not Found');

      const days = WINDOW_DAYS[request.query.window] ?? 30;
      const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const [conn] = await db
        .select({ provider: core.forgeConnections.provider })
        .from(core.repos)
        .innerJoin(core.forgeConnections, eq(core.repos.connectionId, core.forgeConnections.id))
        .where(and(eq(core.repos.id, repo.id), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      const { effective } = await readWorkspaceSettings(db, workspaceId);
      const inputs = await readReviewBotInputs(db, { workspaceId, repoId: repo.id }, windowStart);
      const result = computeReviewBotMetrics({ ...inputs, botGlobs: effective.botLoginGlobs });

      const r = (x: RatioResult) => ({
        value: x.value,
        numerator: x.numerator,
        denominator: x.denominator,
      });
      return reply.send({
        window: request.query.window,
        forge: conn?.provider ?? null,
        line_data: result.lineData,
        prs_in_window: result.prsInWindow,
        prs_with_line_data: result.prsWithLineData,
        other_bot_reviews: result.otherBotReviews,
        bots: result.bots.map((b) => ({
          key: b.key,
          name: b.name,
          logins_seen: b.loginsSeen,
          prs_reviewed: b.prsReviewed,
          reach: r(b.reach),
          reviews: b.reviews,
          reviews_per_pr: r(b.reviewsPerPr),
          prs_with_line_data: b.prsWithLineData,
          inline_comments: b.inlineComments,
          comments_per_pr: b.commentsPerPr ? r(b.commentsPerPr) : null,
          time_to_first: {
            median_hours: b.timeToFirst.medianHours,
            p90_hours: b.timeToFirst.p90Hours,
            n: b.timeToFirst.n,
          },
          followed_by_change: b.followedByChange
            ? { ...r(b.followedByChange), pending: b.followedByChange.pending }
            : null,
          repeat_after_dismiss: b.repeatAfterDismiss
            ? {
                ...r(b.repeatAfterDismiss),
                dismissed_without_inline: b.repeatAfterDismiss.dismissedWithoutInline,
              }
            : null,
        })),
      });
    },
  );

  // GET /repos/{id}/ci — M9's three components (W4-15, METRICS.md §1 M9).
  //
  // Reads the newest M9 snapshot rather than recomputing: metric_snapshots is
  // the read model (Law 4/6), and a screen that recomputed would show numbers
  // the trend chart beside it disagrees with.
  typedApp.get(
    '/repos/:id/ci',
    { schema: { params: idParams, querystring: windowQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repo = await requireRepo(db, workspaceId, request.params.id);
      if (!repo) return fail(request, reply, 404, 'Not Found');

      const [row] = await readMetricTrend(db, {
        workspaceId,
        repoId: repo.id,
        metricKey: 'M9',
        window: request.query.window,
        limit: 1,
      });

      const dims = (row?.dims ?? {}) as {
        passRate?: number | null;
        prPassRate?: number | null;
        defaultBranchRuns?: number;
        prRuns?: number;
        duration?: { medianMs: number | null; p90Ms: number | null };
        flakiness?: {
          workflowName: string;
          flakinessRatio: number | null;
          rerunGroups: number;
          flippedGroups: number;
        }[];
        flakinessWorkflows?: number;
      };

      // A snapshot written before W4-15 carries `passRate` and nothing else.
      // That is NOT the same as a repo with no CI, and conflating the two is
      // how a screen ends up drawing a flat zero line labelled "duration".
      // `duration === undefined` means "this row predates the components".
      const componentsAvailable = dims.duration !== undefined;

      return reply.send({
        window: request.query.window,
        computed_at: row ? row.computedAt : null,
        // METRICS.md §1 M9 reports default-branch and PR runs SEPARATELY.
        pass_rate: dims.passRate ?? null,
        pr_pass_rate: dims.prPassRate ?? null,
        default_branch_runs: dims.defaultBranchRuns ?? null,
        pr_runs: dims.prRuns ?? null,
        duration: dims.duration ?? null,
        flakiest: (dims.flakiness ?? []).map((f) => ({
          workflow: f.workflowName,
          flakiness: f.flakinessRatio,
          rerun_groups: f.rerunGroups,
          flipped_groups: f.flippedGroups,
        })),
        flakiness_workflows: dims.flakinessWorkflows ?? null,
        // The screen shows "this repo has not been snapshotted since CI
        // components landed" instead of an empty chart that reads as "no CI".
        components_available: componentsAvailable,
      });
    },
  );

  /**
   * GET /repos/:id/capabilities — what has actually been measured here (W17-10).
   *
   * The one canonical producer. Every screen that wants to say "this is fresh"
   * or "this has never run" reads this rather than deciding for itself, because
   * two screens deciding separately is how they end up disagreeing in front of
   * a user.
   */
  app.get<{ Params: { id: string } }>('/repos/:id/capabilities', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) {
      sendProblem(request, reply, 401, 'No active session');
      return reply;
    }
    const repoId = Number(request.params.id);
    if (!Number.isInteger(repoId)) {
      sendProblem(request, reply, 400, 'Invalid repository id');
      return reply;
    }

    const result = await repoCapabilities(opts.db, workspaceId, repoId);
    // Tenancy (Law 5): another workspace's repository is a 404, never a 403 —
    // a 403 would confirm the id exists.
    if (!result) {
      sendProblem(request, reply, 404, 'Not Found');
      return reply;
    }

    return reply.send({
      repo_id: result.repoId,
      checked_at: result.checkedAt,
      freshness_hours: result.freshnessHours,
      capabilities: result.capabilities.map((c) => ({
        id: c.id,
        label: c.label,
        kind: c.kind,
        state: c.state,
        last_success_at: c.lastSuccessAt,
        latest_run_id: c.latestRunId,
        last_success_ref: c.lastSuccessRef,
        stale: c.stale,
        detail: c.detail,
      })),
    });
  });
}
