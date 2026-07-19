import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, facts, type Database } from '@repopulse/shared';
import { prSizeBucket } from '@repopulse/metrics';
import { sendProblem } from '../../lib/problem.js';

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
}
