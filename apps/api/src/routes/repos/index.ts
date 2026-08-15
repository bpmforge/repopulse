import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, facts, type Database } from '@repopulse/shared';
import { rankHotspots } from '@repopulse/insights';
import { computeReviewLoad, readMetricTrend } from '@repopulse/metrics';
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
          isBot: r.reviewerIsBot,
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
        flakiness?: { workflowName: string; flakinessRatio: number | null; rerunGroups: number; flippedGroups: number }[];
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
}
