import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, plans as plansSchema, read, type Database } from '@repopulse/shared';
import { CATALOG_VERSION, generatePlanItems, type MetricSet } from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';

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
      const proposed = generatePlanItems({
        metrics,
        dismissedCatalogIds: dismissed.map((d) => d.catalogId),
      });

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

      if (proposed.length > 0) {
        await db.insert(plansSchema.planItems).values(
          proposed.map((item) => ({
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
        itemCount: proposed.length,
      });

      return reply.code(201).send({ id: plan!.id, item_count: proposed.length });
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
      await db.insert(plansSchema.planItemEvents).values({
        workspaceId,
        planItemId: id,
        fromStatus: item.status,
        toStatus: next,
        actorUserId: userId,
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
