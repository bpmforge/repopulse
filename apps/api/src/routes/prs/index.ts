import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, facts, type Database } from '@repopulse/shared';
import { prSizeBucket } from '@repopulse/metrics';
import { sendProblem } from '../../lib/problem.js';
import { readWorkspaceSettings } from '../../lib/workspace-settings.js';

// PR drill-down (level 3, FR-METRICS-4..8, API_DESIGN §2 'prs'). Warehouse-only.

export interface PrsRoutesOptions {
  db: Database;
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const prParams = idParams.extend({ number: z.coerce.number().int().positive() });
const listQuery = z.object({
  state: z.enum(['open', 'closed', 'merged']).optional(),
  stale: z.coerce.boolean().optional(),
  unreviewed: z.coerce.boolean().optional(),
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

const orgListQuery = z.object({
  state: z.enum(['open', 'closed', 'merged']).optional(),
  stale: z.coerce.boolean().optional(),
  unreviewed: z.coerce.boolean().optional(),
  size_bucket: z.enum(['XS', 'S', 'M', 'L', 'XL']).optional(),
  author: z.string().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
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

      const conds = [eq(facts.pullRequests.repoId, request.params.id)];
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
          links: { self: `/api/v1/repos/${request.params.id}/prs/${p.number}` },
        }));
      return reply.send({ items });
    },
  );

  // GET /repos/{id}/prs/{number} — detail: stages, reviews, checks, files.
  typedApp.get(
    '/repos/:id/prs/:number',
    { schema: { params: prParams } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      if (!(await ownsRepo(db, workspaceId, request.params.id)))
        return fail(request, reply, 404, 'Not Found');

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

      return reply.send({
        number: pr.number,
        title: pr.title,
        state: pr.state,
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

    if (q.state) conds.push(eq(facts.pullRequests.state, q.state));
    if (q.author) conds.push(eq(core.identities.forgeLogin, q.author));

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

    if (q.cursor) {
      const after = decodeCursor(q.cursor);
      if (!after) return fail(request, reply, 400, 'Invalid cursor');
      conds.push(
        sql`(${facts.pullRequests.updatedAt}, ${facts.pullRequests.id}) < (${after.updatedAt}, ${after.id})`,
      );
    }

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
      .orderBy(desc(facts.pullRequests.updatedAt), desc(facts.pullRequests.id))
      .limit(q.limit + 1);

    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > q.limit && last ? encodeCursor(last.updatedAt, last.id) : null;

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
    });
  });
}
