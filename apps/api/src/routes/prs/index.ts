import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, facts, type Database } from '@repopulse/shared';
import { prSizeBucket, readMetricTrend } from '@repopulse/metrics';
import { rankHotspots } from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';
import { prForgeUrl, readRepoForge } from '../../lib/forge-links.js';
import { readWorkspaceSettings } from '../../lib/workspace-settings.js';

// PR drill-down (level 3, FR-METRICS-4..8, API_DESIGN §2 'prs'). Warehouse-only.

export interface PrsRoutesOptions {
  db: Database;
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const prParams = idParams.extend({ number: z.coerce.number().int().positive() });
const WINDOW_DAYS: Record<string, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
  '365d': 365,
};
export const listQuery = z.object({
  state: z.enum(['open', 'closed', 'merged']).optional(),
  stale: z.coerce.boolean().optional(),
  unreviewed: z.coerce.boolean().optional(),
  // The window was MISSING here while both callers sent it (W16-44). Fastify's
  // zod provider drops an unknown query param without complaint, so the repo
  // screen's window control changed every widget on the page except the two
  // built from this list — and nothing anywhere said so.
  window: z.enum(['7d', '14d', '30d', '90d', '365d']).default('30d'),
});

// --- org-wide list (W4-16) ---------------------------------------------------

// METRICS.md §1 M7 bucket bounds on `additions + deletions`. Expressed here as
// SQL ranges rather than by calling prSizeBucket() per row, because the filter
// has to run INSIDE the paginated query: filtering rows out afterwards would
// return short pages (and eventually an empty page with a next_cursor), which
// is the classic way a paginated list looks like it has run out of data.
// Exported for org-list.test.ts, which pins these bounds against prSizeBucket
// at every boundary. A dead-code sweep will see a test as the only consumer —
// it is deliberate: this is a SECOND expression of METRICS.md §1 M7, and an
// unpinned copy is the divergence the test exists to prevent.
export const SIZE_BUCKET_BOUNDS: Record<string, { min: number; max: number | null }> = {
  XS: { min: 0, max: 10 },
  S: { min: 10, max: 100 },
  M: { min: 100, max: 500 },
  L: { min: 500, max: 1000 },
  XL: { min: 1000, max: null },
};

export const orgListQuery = z.object({
  // The GLOBAL repository filter (W16-50). The topbar has serialized `?repos=`
  // since W4-02 and no screen read it; this list is the one where narrowing to
  // a repository is the obvious thing to want, and it had no way to express it.
  //
  // A CSV of ids (W20-05, UX_TODO DSH-13): the topbar's filter is multi-select,
  // and this was parsed as ONE integer, so picking two repositories was a 400.
  repo_id: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .transform((csv) => csv.split(',').map(Number))
    .optional(),
  state: z.enum(['open', 'closed', 'merged']).optional(),
  stale: z.coerce.boolean().optional(),
  unreviewed: z.coerce.boolean().optional(),
  size_bucket: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
  author: z.string().min(1).optional(),
  // W20-20 (UX_TODO DSH-30): PRs this login reviewed (PR Flow's review-load
  // rows drill here). Through the canonical identity, like every reader.
  reviewer: z.string().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  // W20-20 (UX_TODO DSH-45): sortable by last update (default, newest first)
  // or by when the PR was opened (age). The keyset cursor follows the sort.
  sort: z.enum(['updated:desc', 'updated:asc', 'opened:desc', 'opened:asc']).optional(),
});

/**
 * Keyset cursor: `${updatedAtMs}:${id}`.
 *
 * Keyset rather than OFFSET because this list is ordered by updated_at, which
 * CHANGES while a user pages through it — an offset would skip or repeat rows
 * every time a PR was updated mid-scroll. The id is the tiebreak, so two PRs
 * updated in the same millisecond still have a total order.
 */
// Exported with decodeCursor for the same reason: the round-trip and the
// malformed-cursor case are asserted against these, not against copies.
export function encodeCursor(updatedAt: Date, id: number): string {
  return `${updatedAt.getTime()}:${id}`;
}

export function decodeCursor(cursor: string): { updatedAt: Date; id: number } | null {
  const [ms, id] = cursor.split(':');
  const msNum = Number(ms);
  const idNum = Number(id);
  if (!Number.isFinite(msNum) || !Number.isInteger(idNum)) return null;
  return { updatedAt: new Date(msNum), id: idNum };
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

export default async function prsRoutes(
  app: FastifyInstance,
  opts: PrsRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // GET /repos/{id}/prs — PR list with cycle-time fields (FR-WEB-7).
  typedApp.get(
    '/repos/:id/prs',
    { schema: { params: idParams, querystring: listQuery } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      if (!(await ownsRepo(db, workspaceId, request.params.id)))
        return fail(request, reply, 404, 'Not Found');

      // A COHORT of PRs opened in the window, not every PR whose state changed
      // in it. That is what makes the funnel's stages nest: PrFlow derives
      // Reviewed and Merged by filtering this same array, so both are subsets
      // of Opened only if Opened means "opened in the window".
      const days = WINDOW_DAYS[request.query.window] ?? 30;
      const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // W20-12 (UX_TODO DSH-65): State = Open lists EVERY open PR, whatever
      // its age. The oldest still-open PRs are the ones a retro most needs,
      // and the window hid them at the default 30d. PR Flow never asks for
      // state=open, so its cohort (and the funnel's nesting) is unchanged.
      const allOpen = request.query.state === 'open';
      const conds = [
        eq(facts.pullRequests.repoId, request.params.id),
        ...(allOpen ? [] : [gte(facts.pullRequests.createdAt, windowStart)]),
      ];
      if (request.query.state) conds.push(eq(facts.pullRequests.state, request.query.state));
      const rows = await db
        .select({
          number: facts.pullRequests.number,
          title: facts.pullRequests.title,
          author: core.identities.forgeLogin,
          additions: facts.pullRequests.additions,
          deletions: facts.pullRequests.deletions,
          state: facts.pullRequests.state,
          isDraft: facts.pullRequests.isDraft,
          createdAt: facts.pullRequests.createdAt,
          firstReviewAt: facts.pullRequests.firstReviewAt,
          firstApprovalAt: facts.pullRequests.firstApprovalAt,
          mergedAt: facts.pullRequests.mergedAt,
          lastActivityAt: facts.pullRequests.lastActivityAt,
        })
        .from(facts.pullRequests)
        .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
        .where(and(...conds))
        .orderBy(desc(facts.pullRequests.updatedAt));

      const items = rows
        .filter((p) => (request.query.unreviewed ? p.firstReviewAt === null : true))
        .map((p) => ({
          number: p.number,
          title: p.title,
          author: p.author,
          size_bucket: prSizeBucket(p.additions + p.deletions),
          state: p.state,
          opened_at: p.createdAt.toISOString(),
          first_review_at: p.firstReviewAt?.toISOString() ?? null,
          first_approval_at: p.firstApprovalAt?.toISOString() ?? null,
          merged_at: p.mergedAt?.toISOString() ?? null,
          review_covered: p.firstReviewAt !== null,
          is_draft: p.isDraft,
          links: { self: `/api/v1/repos/${request.params.id}/prs/${p.number}` },
        }));
      // What the list covers, so the screen can caption it honestly.
      return reply.send({ items, scope: allOpen ? 'all_open' : 'opened_in_window' });
    },
  );

  // GET /repos/{id}/prs/{number} — detail: stages, reviews, checks, files.
  typedApp.get(
    '/repos/:id/prs/:number',
    { schema: { params: prParams } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      // Workspace-filtered (Law 5); also the facts the forge link is built
      // from (W20-12, UX_TODO DSH-38).
      const forge = await readRepoForge(db, workspaceId, request.params.id);
      if (!forge) return fail(request, reply, 404, 'Not Found');

      const [pr] = await db
        .select()
        .from(facts.pullRequests)
        .where(
          and(
            eq(facts.pullRequests.repoId, request.params.id),
            eq(facts.pullRequests.number, request.params.number),
          ),
        )
        .limit(1);
      if (!pr) return fail(request, reply, 404, 'Not Found');

      const reviews = await db
        .select({
          reviewer: core.identities.forgeLogin,
          state: facts.prReviews.state,
          submittedAt: facts.prReviews.submittedAt,
        })
        .from(facts.prReviews)
        .innerJoin(core.identities, eq(facts.prReviews.reviewerIdentityId, core.identities.id))
        .where(eq(facts.prReviews.pullRequestId, pr.id));
      const checks = await db
        .select({
          name: facts.checkRuns.workflowName,
          conclusion: facts.checkRuns.conclusion,
          status: facts.checkRuns.status,
        })
        .from(facts.checkRuns)
        .where(
          and(
            eq(facts.checkRuns.repoId, request.params.id),
            eq(facts.checkRuns.headSha, pr.headSha),
          ),
        );
      const files = await db
        .select({
          path: facts.prFiles.path,
          additions: facts.prFiles.additions,
          deletions: facts.prFiles.deletions,
          changeType: facts.prFiles.changeType,
        })
        .from(facts.prFiles)
        .where(eq(facts.prFiles.pullRequestId, pr.id));

      // W20-12 (UX_TODO DSH-38): who opened it, the repository's typical stage
      // times to read this PR's against, and each file's current hotspot score.
      // All three are warehouse reads (C1) — the author from identities, the
      // medians from M4's newest 30d snapshot (the same numbers PR Flow and
      // Pulse show), the scores from the repo Hotspots tab's own ranking.
      const [author] = await db
        .select({ login: core.identities.forgeLogin })
        .from(core.identities)
        .where(eq(core.identities.id, pr.authorIdentityId))
        .limit(1);
      const [m4] = await readMetricTrend(db, {
        workspaceId,
        repoId: request.params.id,
        metricKey: 'M4',
        window: '30d',
        limit: 1,
      });
      const stages = (m4?.dims as { stages?: Record<string, { median?: number | null }> } | null)
        ?.stages;
      const medianOf = (key: string): number | null => {
        const v = stages?.[key]?.median;
        return typeof v === 'number' ? v : null;
      };
      const hot = new Map(
        files.length === 0
          ? []
          : (
              await rankHotspots(db, {
                repoIds: [request.params.id],
                asOf: new Date(),
                windowDays: 30,
              })
            ).map((h) => [h.path, h.score] as const),
      );

      return reply.send({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        is_draft: pr.isDraft,
        author: author?.login ?? null,
        forge_url: prForgeUrl(forge, pr.number),
        repo_stage_medians_hours: {
          open_to_first_review: medianOf('openToFirstReview'),
          first_review_to_approved: medianOf('firstReviewToApproved'),
          approved_to_merged: medianOf('approvedToMerged'),
        },
        size_bucket: prSizeBucket(pr.additions + pr.deletions),
        opened_at: pr.createdAt.toISOString(),
        merged_at: pr.mergedAt?.toISOString() ?? null,
        stage_durations: {
          first_review_at: pr.firstReviewAt?.toISOString() ?? null,
          first_approval_at: pr.firstApprovalAt?.toISOString() ?? null,
        },
        reviews: reviews.map((r) => ({
          reviewer: r.reviewer,
          state: r.state,
          submitted_at: r.submittedAt.toISOString(),
        })),
        checks: checks.map((c) => ({ name: c.name, conclusion: c.conclusion, status: c.status })),
        files: files.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          change_type: f.changeType,
          hotspot_score: hot.get(f.path) ?? null,
          links: { file: `/api/v1/repos/${request.params.id}/files/${encodeURIComponent(f.path)}` },
        })),
      });
    },
  );

  // GET /prs — the ORG-WIDE list (W4-16, UX_SPEC §4.c, FR-API-3).
  //
  // W4-05 shipped /pull-requests as a repo picker rather than fanning one
  // request per repo out of the browser: that is an N+1 against the NFR-3 p95
  // <500ms budget which degrades silently as repo count grows — exactly the
  // failure mode a dashboard hides until a customer has 50 repos. One
  // workspace-scoped query replaces it.
  typedApp.get('/prs', { schema: { querystring: orgListQuery } }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const q = request.query;
    // Workspace-scoped FIRST and always (Law 5). Every other condition narrows
    // within the tenant; none can widen past it.
    const conds = [eq(facts.pullRequests.workspaceId, workspaceId)];

    if (q.repo_id) conds.push(inArray(facts.pullRequests.repoId, q.repo_id));
    if (q.state) conds.push(eq(facts.pullRequests.state, q.state));
    if (q.author) conds.push(eq(core.identities.forgeLogin, q.author));
    if (q.reviewer) {
      conds.push(
        sql`exists (select 1 from ${facts.prReviews} r
          join ${core.identities} ri on ri.id = r.reviewer_identity_id
          join ${core.identities} rc on rc.id = coalesce(ri.merged_into_id, ri.id)
          where r.pull_request_id = ${facts.pullRequests.id}
            and r.workspace_id = ${workspaceId}
            and rc.workspace_id = ${workspaceId}
            and (rc.forge_login = ${q.reviewer} or ri.forge_login = ${q.reviewer}))`,
      );
    }

    // EVERY filter runs in SQL, including the two the repo-scoped list applies
    // in JS after the fact. With pagination they have no choice: a page of 25
    // filtered down to 9 in JS is a short page the client reads as "nearly the
    // end".
    if (q.unreviewed) conds.push(isNull(facts.pullRequests.firstReviewAt));

    if (q.size_bucket) {
      const bounds = SIZE_BUCKET_BOUNDS[q.size_bucket];
      if (bounds) {
        const gross = sql`${facts.pullRequests.additions} + ${facts.pullRequests.deletions}`;
        conds.push(sql`${gross} >= ${bounds.min}`);
        if (bounds.max !== null) conds.push(sql`${gross} < ${bounds.max}`);
      }
    }

    if (q.stale) {
      // Stale-N comes from workspace settings, not a literal: W4-09 made it
      // configurable and a second hardcoded 7 here would mean the list and the
      // M8 metric disagreed about what "stale" means.
      const { effective } = await readWorkspaceSettings(db, workspaceId);
      const cutoff = new Date(Date.now() - effective.stalePrDays * 24 * 60 * 60 * 1000);
      conds.push(eq(facts.pullRequests.state, 'open'));
      conds.push(lt(facts.pullRequests.lastActivityAt, cutoff));
    }

    // W20-12 (UX_TODO DSH-45): the TOTAL for these filters, before the cursor
    // narrows to a page — "Next page" alone never said how many there were.
    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(facts.pullRequests)
      .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
      .where(and(...conds));

    const [sortKey, sortDir] = (q.sort ?? 'updated:desc').split(':') as [
      'updated' | 'opened',
      'asc' | 'desc',
    ];
    const sortCol =
      sortKey === 'opened' ? facts.pullRequests.createdAt : facts.pullRequests.updatedAt;
    if (q.cursor) {
      const after = decodeCursor(q.cursor);
      if (!after) return fail(request, reply, 400, 'Invalid cursor');
      // Bound as an ISO string with a cast: a Date inside a raw sql tuple is
      // not serialised by the driver, and the second page answered 500.
      const at = sql`${after.updatedAt.toISOString()}::timestamptz`;
      conds.push(
        sortDir === 'asc'
          ? sql`(${sortCol}, ${facts.pullRequests.id}) > (${at}, ${after.id})`
          : sql`(${sortCol}, ${facts.pullRequests.id}) < (${at}, ${after.id})`,
      );
    }
    const dir = sortDir === 'asc' ? asc : desc;

    // limit + 1: the extra row answers "is there another page" without a second
    // COUNT query, and is dropped before serialising.
    const rows = await db
      .select({
        id: facts.pullRequests.id,
        number: facts.pullRequests.number,
        title: facts.pullRequests.title,
        author: core.identities.forgeLogin,
        repoId: facts.pullRequests.repoId,
        repoOrg: core.repos.org,
        repoName: core.repos.name,
        additions: facts.pullRequests.additions,
        deletions: facts.pullRequests.deletions,
        state: facts.pullRequests.state,
        createdAt: facts.pullRequests.createdAt,
        updatedAt: facts.pullRequests.updatedAt,
        firstReviewAt: facts.pullRequests.firstReviewAt,
        firstApprovalAt: facts.pullRequests.firstApprovalAt,
        mergedAt: facts.pullRequests.mergedAt,
      })
      .from(facts.pullRequests)
      .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
      .innerJoin(core.repos, eq(facts.pullRequests.repoId, core.repos.id))
      .where(and(...conds))
      .orderBy(dir(sortCol), dir(facts.pullRequests.id))
      .limit(q.limit + 1);

    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > q.limit && last
        ? encodeCursor(sortKey === 'opened' ? last.createdAt : last.updatedAt, last.id)
        : null;

    return reply.send({
      items: page.map((p) => ({
        number: p.number,
        title: p.title,
        author: p.author,
        repo: { id: p.repoId, org: p.repoOrg, name: p.repoName },
        size_bucket: prSizeBucket(p.additions + p.deletions),
        state: p.state,
        opened_at: p.createdAt.toISOString(),
        first_review_at: p.firstReviewAt?.toISOString() ?? null,
        first_approval_at: p.firstApprovalAt?.toISOString() ?? null,
        merged_at: p.mergedAt?.toISOString() ?? null,
        review_covered: p.firstReviewAt !== null,
        links: { self: `/api/v1/repos/${p.repoId}/prs/${p.number}` },
      })),
      next_cursor: nextCursor,
      total: counted?.n ?? 0,
    });
  });
}
