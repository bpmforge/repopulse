import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, facts, plans as plansSchema, type Database } from '@repopulse/shared';
import {
  AGREEMENT_DEFAULTS,
  AGREEMENT_KINDS,
  EXCEPTION_WINDOW_DAYS,
  computeExceptions,
  type Agreement,
  type AgreementKind,
  type PrFact,
} from '@repopulse/insights';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';

// Working agreements (W5-08, FR-PLANS-4 / FR-AUTH-4).
//
// Config is admin-only; READING is not. The exception list is the artifact a
// team discusses together, so gating it behind admin would defeat the purpose —
// it would become a management report, which is exactly what N-9 rules out.

export interface AgreementsRoutesOptions {
  db: Database;
}

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  sendProblem(req, reply, status, title, detail === undefined ? {} : { detail });
  return reply;
}

/**
 * Range check for a threshold (W20-17, UX_TODO ADM-65). Nothing was checked,
 * so negative line counts, 0 hours or a CI rate of 90 were all saved and then
 * silently judged every pull request (or none). An empty threshold is fine:
 * it means the documented default. Returns the problem, or null.
 */
export function thresholdProblem(
  kind: AgreementKind,
  threshold: Record<string, unknown>,
): string | null {
  const def = AGREEMENT_DEFAULTS[kind];
  const keys = Object.keys(threshold);
  if (keys.length === 0) return null;
  if (keys.length > 1 || keys[0] !== def.key) {
    return `threshold for ${kind} takes one key: ${def.key}`;
  }
  const v = threshold[def.key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return `${def.key} must be a number`;
  if (def.key === 'rate') {
    return v > 0 && v <= 1 ? null : 'rate is a fraction between 0 and 1 (0.9 = 90%)';
  }
  if (def.key === 'hours') return v > 0 ? null : 'hours must be more than 0';
  if (def.key === 'count')
    return Number.isInteger(v) && v >= 0 ? null : 'count must be a whole number, 0 or more';
  return Number.isInteger(v) && v >= 1 ? null : `${def.key} must be a whole number, 1 or more`;
}

/** PRs in the trailing window, with the review facts an agreement needs. */
async function recentPrs(db: Database, workspaceId: number): Promise<PrFact[]> {
  const since = new Date(Date.now() - EXCEPTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      repoId: facts.pullRequests.repoId,
      number: facts.pullRequests.number,
      title: facts.pullRequests.title,
      additions: facts.pullRequests.additions,
      deletions: facts.pullRequests.deletions,
      createdAt: facts.pullRequests.createdAt,
      mergedAt: facts.pullRequests.mergedAt,
      reviewCount: sql<number>`(select count(*)::int from ${facts.prReviews} where ${facts.prReviews.pullRequestId} = ${facts.pullRequests.id})`,
      firstReviewAt: sql<Date | null>`(select min(${facts.prReviews.submittedAt}) from ${facts.prReviews} where ${facts.prReviews.pullRequestId} = ${facts.pullRequests.id})`,
    })
    .from(facts.pullRequests)
    .where(
      and(
        eq(facts.pullRequests.workspaceId, workspaceId),
        gte(facts.pullRequests.createdAt, since),
      ),
    )
    .orderBy(desc(facts.pullRequests.createdAt))
    .limit(500);

  return rows.map((r) => ({
    repoId: r.repoId,
    number: r.number,
    title: r.title,
    additions: r.additions ?? 0,
    deletions: r.deletions ?? 0,
    reviewCount: r.reviewCount ?? 0,
    firstReviewAt: null,
    // null when never reviewed — a distinct fact from "reviewed slowly",
    // which is why computeExceptions treats the two separately.
    firstReviewHours:
      r.firstReviewAt === null
        ? null
        : (new Date(r.firstReviewAt).getTime() - r.createdAt.getTime()) / 3_600_000,
    mergedAt: r.mergedAt,
  })) as PrFact[];
}

export default async function agreementsRoutes(
  app: FastifyInstance,
  opts: AgreementsRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /agreements — every member may read; the list is a team artifact. */
  app.get('/agreements', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const rows = await db
      .select()
      .from(plansSchema.agreements)
      .where(eq(plansSchema.agreements.workspaceId, workspaceId))
      .orderBy(plansSchema.agreements.kind);

    const prs = rows.length > 0 ? await recentPrs(db, workspaceId) : [];
    const repos = await db
      .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, workspaceId));
    const repoName = new Map(repos.map((r) => [r.id, `${r.org}/${r.name}`]));

    return reply.send({
      items: rows.map((row) => {
        const agreement: Agreement = {
          id: row.id,
          kind: row.kind as AgreementKind,
          threshold: row.threshold,
          repoIds: row.repoIds,
          active: row.active,
        };
        // Computed at read time, never stored (§4): a PR reviewed after the
        // fact would otherwise sit in a table as an exception forever.
        const exceptions = row.active ? computeExceptions(agreement, prs) : [];
        return {
          id: row.id,
          kind: row.kind,
          threshold: row.threshold,
          repo_ids: row.repoIds,
          active: row.active,
          window_days: EXCEPTION_WINDOW_DAYS,
          exception_count: exceptions.length,
          exceptions: exceptions.slice(0, 25).map((e) => ({
            repo: repoName.get(e.repoId) ?? String(e.repoId),
            repo_id: e.repoId,
            pr_number: e.prNumber,
            title: e.title,
            detail: e.detail,
            links: { pr: `/api/v1/repos/${e.repoId}/prs/${e.prNumber}` },
          })),
        };
      }),
    });
  });

  /** POST /agreements — admin-only config. */
  app.post<{ Body: { kind?: unknown; threshold?: unknown; repo_ids?: unknown } }>(
    '/agreements',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const kind = request.body?.kind;
      if (typeof kind !== 'string' || !AGREEMENT_KINDS.includes(kind as AgreementKind)) {
        return fail(
          request,
          reply,
          400,
          'Invalid kind',
          `kind must be one of ${AGREEMENT_KINDS.join(', ')}`,
        );
      }
      const threshold =
        request.body?.threshold && typeof request.body.threshold === 'object'
          ? (request.body.threshold as Record<string, unknown>)
          : {};
      const problem = thresholdProblem(kind as AgreementKind, threshold);
      if (problem) return fail(request, reply, 400, 'Invalid threshold', problem);
      const repoIds = Array.isArray(request.body?.repo_ids)
        ? (request.body.repo_ids as unknown[]).map(Number).filter(Number.isInteger)
        : [];

      const [row] = await db
        .insert(plansSchema.agreements)
        .values({ workspaceId, kind, threshold, repoIds, active: true, createdBy: userId })
        .returning();

      auditLog(request.log, {
        event: 'agreement.configured',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        agreementId: row!.id,
        kind,
      });

      return reply.code(201).send({ id: row!.id, kind: row!.kind, active: row!.active });
    },
  );

  /** PATCH /agreements/:id — activate/deactivate or retune, admin-only. */
  app.patch<{ Params: { id: string }; Body: { active?: unknown; threshold?: unknown } }>(
    '/agreements/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid agreement id');

      const [existing] = await db
        .select()
        .from(plansSchema.agreements)
        .where(
          and(
            eq(plansSchema.agreements.id, id),
            eq(plansSchema.agreements.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      // Tenancy (Law 5): another workspace's agreement is a 404, never a 403.
      if (!existing) return fail(request, reply, 404, 'Not Found');

      const patch: { active?: boolean; threshold?: Record<string, unknown> } = {};
      if (typeof request.body?.active === 'boolean') patch.active = request.body.active;
      if (request.body?.threshold && typeof request.body.threshold === 'object') {
        patch.threshold = request.body.threshold as Record<string, unknown>;
      }
      if (Object.keys(patch).length === 0) {
        return fail(request, reply, 400, 'Invalid body', 'active or threshold is required');
      }
      if (patch.threshold) {
        const problem = thresholdProblem(existing.kind as AgreementKind, patch.threshold);
        if (problem) return fail(request, reply, 400, 'Invalid threshold', problem);
      }

      // Workspace-filtered as well as id-filtered (Law 5), though the select
      // above already proved the row is this workspace's.
      await db
        .update(plansSchema.agreements)
        .set(patch)
        .where(
          and(
            eq(plansSchema.agreements.id, id),
            eq(plansSchema.agreements.workspaceId, workspaceId),
          ),
        );

      auditLog(request.log, {
        event: 'agreement.configured',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        agreementId: id,
        kind: existing.kind,
        changedKeys: Object.keys(patch),
      });

      return reply.send({ id, ...patch });
    },
  );

  /** DELETE /agreements/:id — admin-only. */
  app.delete<{ Params: { id: string } }>(
    '/agreements/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid agreement id');
      const deleted = await db
        .delete(plansSchema.agreements)
        .where(
          and(
            eq(plansSchema.agreements.id, id),
            eq(plansSchema.agreements.workspaceId, workspaceId),
          ),
        )
        .returning({ id: plansSchema.agreements.id });
      if (deleted.length === 0) return fail(request, reply, 404, 'Not Found');
      return reply.send({ id, deleted: true });
    },
  );
}
