import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, facts, plans as plansSchema, read, type Database } from '@repopulse/shared';
import {
  AGREEMENT_CATALOG_ID,
  CATALOG_VERSION,
  EXCEPTION_WINDOW_DAYS,
  computeExceptions,
  findCatalogEntry,
  generatePlanItems,
  type Agreement,
  type AgreementKind,
  type MetricSet,
} from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';
import { actorLoginFor } from '../../lib/actor.js';

// Plans API (W5-06, FR-PLANS-2/6).
//
// Team-scoped by construction: nothing here reads or writes a person, and the
// tables have no column for one (N-9). Items name a repository, a metric or a
// finding set — never who should fix it.

export interface PlansRoutesOptions {
  db: Database;
}

const HUMAN_TRANSITIONS: Record<string, string[]> = {
  proposed: ['accepted', 'dismissed'],
  accepted: ['in_progress', 'dismissed'],
  in_progress: ['accepted', 'dismissed'],
  // done/regressed are the verifier's to set; a human may still dismiss.
  done: ['dismissed'],
  regressed: ['accepted', 'in_progress', 'dismissed'],
  dismissed: ['proposed'],
};

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

/** Latest snapshot per metric for the scope, shaped for the catalog. */
async function metricsForScope(
  db: Database,
  workspaceId: number,
  repoIds: number[],
  window: string,
): Promise<MetricSet> {
  const rows = await db
    .select()
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, workspaceId),
        eq(read.metricSnapshots.window, window),
        repoIds.length > 0 ? inArray(read.metricSnapshots.repoId, repoIds) : undefined,
      ),
    )
    .orderBy(desc(read.metricSnapshots.computedAt));

  const set: MetricSet = {};
  for (const r of rows) {
    // Newest-first, so the first row per key wins.
    if (set[r.metricKey]) continue;
    set[r.metricKey] = {
      value: r.value === null ? null : Number(r.value),
      dims: (r.dims ?? {}) as Record<string, unknown>,
    };
  }
  return set;
}

/**
 * Plan items raised by a breached working agreement (W5-08).
 *
 * `already` carries the catalog ids the metric pass produced plus everything
 * dismissed, so an agreement can only ADD an item nobody has raised or refused.
 */
async function agreementSourcedItems(
  db: Database,
  workspaceId: number,
  already: ReadonlySet<string>,
): Promise<
  {
    catalogId: string;
    rank: number;
    source: 'agreement';
    effort: 'S' | 'M' | 'L';
    recommendation: string;
    evidence: Record<string, unknown>;
    verifyCriterion: Record<string, unknown>;
  }[]
> {
  const rows = await db
    .select()
    .from(plansSchema.agreements)
    .where(and(eq(plansSchema.agreements.workspaceId, workspaceId), eq(plansSchema.agreements.active, true)));
  if (rows.length === 0) return [];

  const since = new Date(Date.now() - EXCEPTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const prRows = await db
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
    .where(and(eq(facts.pullRequests.workspaceId, workspaceId), gte(facts.pullRequests.createdAt, since)))
    .limit(500);

  const prs = prRows.map((r) => ({
    repoId: r.repoId,
    number: r.number,
    title: r.title,
    additions: r.additions ?? 0,
    deletions: r.deletions ?? 0,
    reviewCount: r.reviewCount ?? 0,
    firstReviewHours:
      r.firstReviewAt === null
        ? null
        : (new Date(r.firstReviewAt).getTime() - r.createdAt.getTime()) / 3_600_000,
    mergedAt: r.mergedAt,
  }));

  const out: Awaited<ReturnType<typeof agreementSourcedItems>> = [];
  for (const row of rows) {
    const agreement: Agreement = {
      id: row.id,
      kind: row.kind as AgreementKind,
      threshold: row.threshold,
      repoIds: row.repoIds,
      active: row.active,
    };
    const catalogId = AGREEMENT_CATALOG_ID[agreement.kind];
    if (already.has(catalogId) || out.some((o) => o.catalogId === catalogId)) continue;
    const exceptions = computeExceptions(agreement, prs);
    if (exceptions.length === 0) continue;
    const entry = findCatalogEntry(catalogId);
    if (!entry) continue;

    out.push({
      catalogId,
      rank: 0,
      source: 'agreement',
      effort: entry.effort,
      recommendation: entry.title,
      evidence: {
        agreementId: agreement.id,
        agreementKind: agreement.kind,
        // PR numbers, never authors — the item points at artifacts (N-9).
        exceptions: exceptions.slice(0, 20).map((e) => ({ repoId: e.repoId, prNumber: e.prNumber })),
      },
      verifyCriterion: entry.verifyCriterion as unknown as Record<string, unknown>,
    });
  }
  return out;
}

export default async function plansRoutes(
  app: FastifyInstance,
  opts: PlansRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** POST /plans — evaluate the catalog over a scope and store ranked items. */
  app.post<{ Body: { repo_ids?: unknown; window?: unknown; from_report_id?: unknown } }>(
    '/plans',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const window = typeof request.body?.window === 'string' ? request.body.window : '30d';
      const repoIds = Array.isArray(request.body?.repo_ids)
        ? (request.body.repo_ids as unknown[]).map(Number).filter(Number.isInteger)
        : [];

      // Dismissals are per catalog id and survive regeneration (FR-PLANS-2).
      // Without this the next generation undoes a human decision, and the
      // dismiss button becomes something people learn to ignore.
      const dismissed = await db
        .selectDistinct({ catalogId: plansSchema.planItems.catalogId })
        .from(plansSchema.planItems)
        .where(
          and(
            eq(plansSchema.planItems.workspaceId, workspaceId),
            eq(plansSchema.planItems.status, 'dismissed'),
          ),
        );

      const metrics = await metricsForScope(db, workspaceId, repoIds, window);
      const dismissedIds = dismissed.map((d) => d.catalogId);
      const proposed = generatePlanItems({ metrics, dismissedCatalogIds: dismissedIds });

      // Agreement breaches feed the SAME catalog entries (IMPROVEMENT_PLANS.md
      // §1), marked source='agreement'. Deduped against what the metric pass
      // already proposed: a team that agreed a PR-size limit AND breaches the
      // metric threshold has one problem, not two, and listing it twice makes
      // the plan look padded.
      const agreementItems = await agreementSourcedItems(
        db,
        workspaceId,
        new Set([...proposed.map((p) => p.catalogId), ...dismissedIds]),
      );
      const allProposed = [...proposed, ...agreementItems].map((item, index) => ({
        ...item,
        rank: index + 1,
      }));

      const [plan] = await db
        .insert(plansSchema.improvementPlans)
        .values({
          workspaceId,
          repoIds,
          window,
          catalogVersion: CATALOG_VERSION,
          status: 'active',
          createdBy: userId,
          ...(Number.isInteger(Number(request.body?.from_report_id))
            ? { createdFromReportId: Number(request.body.from_report_id) }
            : {}),
        })
        .returning();

      if (allProposed.length > 0) {
        await db.insert(plansSchema.planItems).values(
          allProposed.map((item) => ({
            workspaceId,
            planId: plan!.id,
            rank: item.rank,
            catalogId: item.catalogId,
            source: item.source,
            evidence: item.evidence,
            recommendation: item.recommendation,
            effort: item.effort,
            status: 'proposed',
            verifyCriterion: item.verifyCriterion as unknown as Record<string, unknown>,
          })),
        );
      }

      auditLog(request.log, {
        event: 'plan.generated',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        planId: plan!.id,
        itemCount: allProposed.length,
      });

      return reply.code(201).send({ id: plan!.id, item_count: allProposed.length });
    },
  );

  /** GET /plans — plans with their items, newest first. */
  app.get('/plans', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const planRows = await db
      .select()
      .from(plansSchema.improvementPlans)
      .where(eq(plansSchema.improvementPlans.workspaceId, workspaceId))
      .orderBy(desc(plansSchema.improvementPlans.createdAt))
      .limit(20);

    const itemRows =
      planRows.length === 0
        ? []
        : await db
            .select()
            .from(plansSchema.planItems)
            .where(
              and(
                eq(plansSchema.planItems.workspaceId, workspaceId),
                inArray(
                  plansSchema.planItems.planId,
                  planRows.map((p) => p.id),
                ),
              ),
            )
            .orderBy(plansSchema.planItems.rank);

    return reply.send({
      items: planRows.map((p) => ({
        id: p.id,
        window: p.window,
        repo_ids: p.repoIds,
        catalog_version: p.catalogVersion,
        status: p.status,
        created_at: p.createdAt.toISOString(),
        items: itemRows
          .filter((i) => i.planId === p.id)
          .map((i) => ({
            id: i.id,
            rank: i.rank,
            catalog_id: i.catalogId,
            source: i.source,
            recommendation: i.recommendation,
            effort: i.effort,
            status: i.status,
            evidence: i.evidence,
            verify_criterion: i.verifyCriterion,
            verified_at: i.verifiedAt?.toISOString() ?? null,
          })),
      })),
    });
  });

  /** PATCH /plans/items/:id — a human moving an item through its lifecycle. */
  app.patch<{ Params: { id: string }; Body: { status?: unknown } }>(
    '/plans/items/:id',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid item id');
      const next = request.body?.status;
      if (typeof next !== 'string') return fail(request, reply, 400, 'Invalid body', 'status is required');

      const [item] = await db
        .select()
        .from(plansSchema.planItems)
        .where(and(eq(plansSchema.planItems.id, id), eq(plansSchema.planItems.workspaceId, workspaceId)))
        .limit(1);
      // Tenancy (Law 5): another workspace's item is a 404, never a 403.
      if (!item) return fail(request, reply, 404, 'Not Found');

      const allowed = HUMAN_TRANSITIONS[item.status] ?? [];
      if (!allowed.includes(next)) {
        // 409, not 400: the request is well-formed, the STATE forbids it. A
        // human marking something done by hand would also defeat the point of
        // automatic verification, so `done` is not in any allowed list.
        return fail(
          request,
          reply,
          409,
          'Transition not allowed',
          `${item.status} → ${next} is not a human transition (allowed: ${allowed.join(', ') || 'none'})`,
        );
      }

      const now = new Date();
      await db
        .update(plansSchema.planItems)
        .set({ status: next, statusChangedBy: userId, statusChangedAt: now })
        .where(eq(plansSchema.planItems.id, id));
      // The login beside the id (W16-59), so a plan's history keeps saying who
      // accepted an item after that account is gone.
      const actorLogin = await actorLoginFor(db, userId);
      await db.insert(plansSchema.planItemEvents).values({
        workspaceId,
        planItemId: id,
        fromStatus: item.status,
        toStatus: next,
        actorUserId: userId,
        actorLogin,
        reason: 'human transition',
      });

      auditLog(request.log, {
        event: 'plan.item.transitioned',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        planItemId: id,
        fromStatus: item.status,
        toStatus: next,
      });

      return reply.send({ id, status: next });
    },
  );
}
