import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  auditLog,
  core,
  facts,
  plans as plansSchema,
  read,
  type Database,
} from '@repopulse/shared';
import {
  AGREEMENT_CATALOG_ID,
  CATALOG_VERSION,
  EXCEPTION_WINDOW_DAYS,
  computeExceptions,
  findCatalogEntry,
  generatePlanItems,
  isSameProposal,
  normalizeRepoIds,
  planScopeKey,
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

/** The generator runs inside one transaction (W17-24); its readers take either. */
type Queryable = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * What a person may do to an item. `done` and `regressed` appear in NO list:
 * they are the verifier's to set from a measured number (W5-06, W17-25), and
 * a hand-set done would make the whole verification story decorative.
 */
export const HUMAN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  proposed: ['accepted', 'dismissed'],
  accepted: ['in_progress', 'dismissed'],
  in_progress: ['accepted', 'dismissed'],
  // done/regressed are the verifier's to set; a human may still dismiss.
  done: ['dismissed'],
  regressed: ['accepted', 'in_progress', 'dismissed'],
  dismissed: ['proposed'],
};

export function humanTransitionAllowed(from: string, to: string): boolean {
  return (HUMAN_TRANSITIONS[from] ?? []).includes(to);
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

/** Latest snapshot per metric for the scope, shaped for the catalog. */
async function metricsForScope(
  db: Queryable,
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
  db: Queryable,
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
    .where(
      and(
        eq(plansSchema.agreements.workspaceId, workspaceId),
        eq(plansSchema.agreements.active, true),
      ),
    );
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
    .where(
      and(
        eq(facts.pullRequests.workspaceId, workspaceId),
        gte(facts.pullRequests.createdAt, since),
      ),
    )
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
        exceptions: exceptions
          .slice(0, 20)
          .map((e) => ({ repoId: e.repoId, prNumber: e.prNumber })),
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

  /**
   * POST /plans — evaluate the catalog over a scope and store ranked items.
   *
   * ONE PLAN PER SCOPE PER CONTENT (W17-24). Generation is serialised on the
   * scope (workspace + window + repositories) with a transaction-scoped
   * advisory lock, and inside the lock the fresh proposal is compared with the
   * newest active plan for that scope: identical content is the SAME plan,
   * answered 200 with `reused: true`, not a second row. Two presses of the
   * button, or two tabs, therefore land on one plan — and the items a person
   * has already accepted in it are not re-proposed beside it.
   *
   * Never called by a GET. Listing plans, opening a finding or landing on the
   * Plans page with a repository in the URL reads only.
   */
  app.post<{ Body: { repo_ids?: unknown; window?: unknown; from_report_id?: unknown } }>(
    '/plans',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const window = typeof request.body?.window === 'string' ? request.body.window : '30d';
      const requested = Array.isArray(request.body?.repo_ids)
        ? (request.body.repo_ids as unknown[]).map(Number)
        : [];
      if (requested.some((id) => !Number.isInteger(id) || id <= 0)) {
        return fail(request, reply, 400, 'Invalid body', 'repo_ids must be positive integers');
      }
      const repoIds = normalizeRepoIds(requested);

      // The scope is recorded on the plan and shown as its label, so it must
      // name repositories this workspace can see. Another workspace's id is a
      // 404 (Law 5), and an unknown id is the same 404 — a plan "for repo 99"
      // where 99 is nothing would be a label with nothing behind it.
      if (repoIds.length > 0) {
        const known = await db
          .select({ id: core.repos.id })
          .from(core.repos)
          .where(and(eq(core.repos.workspaceId, workspaceId), inArray(core.repos.id, repoIds)));
        if (known.length !== repoIds.length) return fail(request, reply, 404, 'Not Found');
      }

      const fromReportId = Number.isInteger(Number(request.body?.from_report_id))
        ? Number(request.body.from_report_id)
        : undefined;

      const result = await db.transaction(async (tx) => {
        // Held until commit: a concurrent generation for the same scope waits
        // here, then sees the plan this one wrote and reuses it.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${planScopeKey(workspaceId, window, repoIds)}))`,
        );

        // Dismissals are per catalog id and survive regeneration (FR-PLANS-2).
        // Without this the next generation undoes a human decision, and the
        // dismiss button becomes something people learn to ignore.
        const dismissed = await tx
          .selectDistinct({ catalogId: plansSchema.planItems.catalogId })
          .from(plansSchema.planItems)
          .where(
            and(
              eq(plansSchema.planItems.workspaceId, workspaceId),
              eq(plansSchema.planItems.status, 'dismissed'),
            ),
          );

        const metrics = await metricsForScope(tx, workspaceId, repoIds, window);
        const dismissedIds = dismissed.map((d) => d.catalogId);
        const proposed = generatePlanItems({ metrics, dismissedCatalogIds: dismissedIds });

        // Agreement breaches feed the SAME catalog entries (IMPROVEMENT_PLANS.md
        // §1), marked source='agreement'. Deduped against what the metric pass
        // already proposed: a team that agreed a PR-size limit AND breaches the
        // metric threshold has one problem, not two, and listing it twice makes
        // the plan look padded.
        const agreementItems = await agreementSourcedItems(
          tx,
          workspaceId,
          new Set([...proposed.map((p) => p.catalogId), ...dismissedIds]),
        );
        const allProposed = [...proposed, ...agreementItems].map((item, index) => ({
          ...item,
          rank: index + 1,
        }));

        // The newest active plan for EXACTLY this scope — same window, same
        // repositories, same catalog. A plan for the whole workspace is not the
        // plan for one of its repositories.
        const candidates = await tx
          .select({
            id: plansSchema.improvementPlans.id,
            repoIds: plansSchema.improvementPlans.repoIds,
          })
          .from(plansSchema.improvementPlans)
          .where(
            and(
              eq(plansSchema.improvementPlans.workspaceId, workspaceId),
              eq(plansSchema.improvementPlans.window, window),
              eq(plansSchema.improvementPlans.catalogVersion, CATALOG_VERSION),
              eq(plansSchema.improvementPlans.status, 'active'),
            ),
          )
          .orderBy(
            desc(plansSchema.improvementPlans.createdAt),
            desc(plansSchema.improvementPlans.id),
          )
          .limit(50);
        const existing = candidates.find(
          (c) =>
            planScopeKey(workspaceId, window, c.repoIds) ===
            planScopeKey(workspaceId, window, repoIds),
        );
        if (existing) {
          const items = await tx
            .select({
              catalogId: plansSchema.planItems.catalogId,
              status: plansSchema.planItems.status,
            })
            .from(plansSchema.planItems)
            .where(
              and(
                eq(plansSchema.planItems.workspaceId, workspaceId),
                eq(plansSchema.planItems.planId, existing.id),
              ),
            )
            .orderBy(plansSchema.planItems.rank);
          if (isSameProposal(allProposed, items)) {
            return { id: existing.id, itemCount: items.length, reused: true as const };
          }
        }

        const [plan] = await tx
          .insert(plansSchema.improvementPlans)
          .values({
            workspaceId,
            repoIds,
            window,
            catalogVersion: CATALOG_VERSION,
            status: 'active',
            createdBy: userId,
            ...(fromReportId === undefined ? {} : { createdFromReportId: fromReportId }),
          })
          .returning();

        if (allProposed.length > 0) {
          await tx.insert(plansSchema.planItems).values(
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
        return { id: plan!.id, itemCount: allProposed.length, reused: false as const };
      });

      auditLog(request.log, {
        event: 'plan.generated',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        planId: result.id,
        itemCount: result.itemCount,
        // A reuse is still the answer to a generate request, so it is logged
        // as one — with the fact that no row was written.
        reused: result.reused,
      });

      return reply.code(result.reused ? 200 : 201).send({
        id: result.id,
        item_count: result.itemCount,
        reused: result.reused,
        repo_ids: repoIds,
        window,
      });
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
  app.patch<{ Params: { id: string }; Body: { status?: unknown; reason?: unknown } }>(
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
      if (typeof next !== 'string')
        return fail(request, reply, 400, 'Invalid body', 'status is required');
      // The person's own words, when they gave some (W20-05, UX_TODO DSH-14):
      // a dismissal now asks why, and the history row is where that answer is
      // kept. Optional here so older clients still transition.
      const rawReason = request.body?.reason;
      if (rawReason !== undefined && (typeof rawReason !== 'string' || rawReason.length > 500)) {
        return fail(
          request,
          reply,
          400,
          'Invalid body',
          'reason must be a string of at most 500 characters',
        );
      }
      const reason =
        typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : 'human transition';

      const [item] = await db
        .select()
        .from(plansSchema.planItems)
        .where(
          and(eq(plansSchema.planItems.id, id), eq(plansSchema.planItems.workspaceId, workspaceId)),
        )
        .limit(1);
      // Tenancy (Law 5): another workspace's item is a 404, never a 403.
      if (!item) return fail(request, reply, 404, 'Not Found');

      const allowed = HUMAN_TRANSITIONS[item.status] ?? [];
      if (!humanTransitionAllowed(item.status, next)) {
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
      // The login beside the id (W16-59), so a plan's history keeps saying who
      // accepted an item after that account is gone.
      const actorLogin = await actorLoginFor(db, userId);
      // Status write and history row in ONE transaction, guarded on the status
      // that was read (W17-25, as W17-23 did for findings): two people who
      // both read `proposed` cannot both accept it and write two events — the
      // second gets the same 409 an invalid transition gets.
      const applied = await db.transaction(async (tx) => {
        const updated = await tx
          .update(plansSchema.planItems)
          .set({ status: next, statusChangedBy: userId, statusChangedAt: now })
          .where(
            and(eq(plansSchema.planItems.id, id), eq(plansSchema.planItems.status, item.status)),
          )
          .returning({ id: plansSchema.planItems.id });
        if (updated.length === 0) return false;
        await tx.insert(plansSchema.planItemEvents).values({
          workspaceId,
          planItemId: id,
          fromStatus: item.status,
          toStatus: next,
          actorUserId: userId,
          actorLogin,
          reason,
        });
        return true;
      });
      if (!applied) {
        return fail(
          request,
          reply,
          409,
          'Transition not allowed',
          `item ${id} was no longer ${item.status} when the change was applied`,
        );
      }

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
