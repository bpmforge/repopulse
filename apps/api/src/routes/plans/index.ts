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
} from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';
import { scopedMetrics } from '../../lib/scope-metrics.js';
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

/**
 * Item states a regeneration keeps (W20-09, UX_TODO DSH-58): what a person
 * agreed to, what is under way, and what the verifier has measured. `proposed`
 * is the default anyway; `dismissed` is carried separately.
 */
const CARRIED_STATUSES = ['accepted', 'in_progress', 'done', 'regressed'];

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

/**
 * Plan items raised by a breached working agreement (W5-08).
 *
 * `already` carries the catalog ids the metric pass produced plus everything
 * dismissed, so an agreement can only ADD an item nobody has raised or refused.
 *
 * `repoIds` is the plan's scope (W20-09, UX_TODO DSH-86): only that set's PRs
 * are checked, so a plan for acme/web is never handed an item raised by
 * acme/api's PRs. Empty = the whole workspace, as everywhere else.
 */
async function agreementSourcedItems(
  db: Queryable,
  workspaceId: number,
  repoIds: readonly number[],
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
        repoIds.length > 0 ? inArray(facts.pullRequests.repoId, [...repoIds]) : undefined,
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

      const rawReportId = request.body?.from_report_id;
      const fromReportId =
        rawReportId !== undefined && rawReportId !== null && Number.isInteger(Number(rawReportId))
          ? Number(rawReportId)
          : undefined;
      // The report a plan is made from must be this workspace's (Law 5; W20-09,
      // UX_TODO DSH-59 is what started sending it): another tenant's id is the
      // same 404 an unknown one is, and no plan is written.
      if (fromReportId !== undefined) {
        const [report] = await db
          .select({ id: read.reports.id })
          .from(read.reports)
          .where(and(eq(read.reports.id, fromReportId), eq(read.reports.workspaceId, workspaceId)))
          .limit(1);
        if (!report) return fail(request, reply, 404, 'Not Found');
      }

      const result = await db.transaction(async (tx) => {
        // Held until commit: a concurrent generation for the same scope waits
        // here, then sees the plan this one wrote and reuses it.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${planScopeKey(workspaceId, window, repoIds)}))`,
        );

        // Dismissals are per catalog id and survive regeneration (FR-PLANS-2).
        // Without this the next generation undoes a human decision, and the
        // dismiss button becomes something people learn to ignore.
        //
        // SCOPED TO THE REPOSITORIES (W20-09, UX_TODO DSH-57). This read every
        // dismissal in the workspace, so dismissing "add CODEOWNERS" on one
        // repository's plan hid it from every future plan for every repository
        // and every window. A dismissal now speaks for the plan's own set of
        // repositories — under any window, since "not for this repo" does not
        // change when the window does (IMPROVEMENT_PLANS.md §2: "while the same
        // catalog id + scope stays").
        const dismissedRows = await tx
          .select({
            catalogId: plansSchema.planItems.catalogId,
            repoIds: plansSchema.improvementPlans.repoIds,
          })
          .from(plansSchema.planItems)
          .innerJoin(
            plansSchema.improvementPlans,
            eq(plansSchema.improvementPlans.id, plansSchema.planItems.planId),
          )
          .where(
            and(
              eq(plansSchema.planItems.workspaceId, workspaceId),
              eq(plansSchema.improvementPlans.workspaceId, workspaceId),
              eq(plansSchema.planItems.status, 'dismissed'),
            ),
          );
        const scopeRepos = repoIds.join(',');
        const dismissed = [
          ...new Set(
            dismissedRows
              .filter((d) => normalizeRepoIds(d.repoIds).join(',') === scopeRepos)
              .map((d) => d.catalogId),
          ),
        ].map((catalogId) => ({ catalogId }));

        // The SET's value per metric, not one repository's (DSH-86).
        const metrics = await scopedMetrics(tx, workspaceId, repoIds, window);
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
          repoIds,
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
            return {
              id: existing.id,
              itemCount: items.length,
              reused: true as const,
              supersededId: null,
            };
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

        // SUPERSEDE, AND CARRY THE WORK OVER (W20-09, UX_TODO DSH-58). A
        // regeneration after the metrics moved used to leave the old plan
        // active beside the new one, both headed "30d · All repositories", and
        // every item the team had accepted or started came back `proposed` in
        // the new one. The earlier plans for EXACTLY this scope are archived
        // (history, not deleted), and an item the team had already decided on
        // keeps that decision in the new plan.
        const superseded = candidates.filter(
          (c) =>
            planScopeKey(workspaceId, window, c.repoIds) ===
            planScopeKey(workspaceId, window, repoIds),
        );
        const carried = new Map<string, { status: string; verifiedAt: Date | null }>();
        let carriedDismissed: (typeof plansSchema.planItems.$inferSelect)[] = [];
        if (superseded.length > 0) {
          const supersededIds = superseded.map((c) => c.id);
          const previous = await tx
            .select()
            .from(plansSchema.planItems)
            .where(
              and(
                eq(plansSchema.planItems.workspaceId, workspaceId),
                inArray(plansSchema.planItems.planId, supersededIds),
              ),
            )
            .orderBy(desc(plansSchema.planItems.planId));
          // Newest plan first, so its state wins when two archived plans
          // disagree about the same catalog id.
          for (const item of previous) {
            if (CARRIED_STATUSES.includes(item.status) && !carried.has(item.catalogId)) {
              carried.set(item.catalogId, { status: item.status, verifiedAt: item.verifiedAt });
            }
          }
          // The dismissed items come along as dismissed, so "Dismissed (n)" and
          // its Restore still exist on the plan people are looking at.
          const seen = new Set<string>();
          carriedDismissed = previous.filter((item) => {
            if (item.status !== 'dismissed' || seen.has(item.catalogId)) return false;
            seen.add(item.catalogId);
            return !allProposed.some((p) => p.catalogId === item.catalogId);
          });
          await tx
            .update(plansSchema.improvementPlans)
            .set({ status: 'archived' })
            .where(
              and(
                eq(plansSchema.improvementPlans.workspaceId, workspaceId),
                inArray(plansSchema.improvementPlans.id, supersededIds),
              ),
            );
        }

        const now = new Date();
        const inserted =
          allProposed.length + carriedDismissed.length === 0
            ? []
            : await tx
                .insert(plansSchema.planItems)
                .values([
                  ...allProposed.map((item) => {
                    const kept = carried.get(item.catalogId);
                    return {
                      workspaceId,
                      planId: plan!.id,
                      rank: item.rank,
                      catalogId: item.catalogId,
                      source: item.source,
                      evidence: item.evidence,
                      recommendation: item.recommendation,
                      effort: item.effort,
                      status: kept?.status ?? 'proposed',
                      verifiedAt: kept?.verifiedAt ?? null,
                      statusChangedAt: now,
                      verifyCriterion: item.verifyCriterion as unknown as Record<string, unknown>,
                    };
                  }),
                  ...carriedDismissed.map((item, index) => ({
                    workspaceId,
                    planId: plan!.id,
                    rank: allProposed.length + index + 1,
                    catalogId: item.catalogId,
                    source: item.source,
                    evidence: item.evidence,
                    recommendation: item.recommendation,
                    effort: item.effort,
                    status: 'dismissed',
                    statusChangedAt: now,
                    verifyCriterion: item.verifyCriterion,
                  })),
                ])
                .returning({
                  id: plansSchema.planItems.id,
                  catalogId: plansSchema.planItems.catalogId,
                  status: plansSchema.planItems.status,
                });
        // A carried state is a transition nobody made by hand in THIS plan, so
        // its history says where it came from rather than starting blank.
        const carriedEvents = inserted.filter((i) => i.status !== 'proposed');
        if (carriedEvents.length > 0) {
          await tx.insert(plansSchema.planItemEvents).values(
            carriedEvents.map((i) => ({
              workspaceId,
              planItemId: i.id,
              fromStatus: 'proposed',
              toStatus: i.status,
              actorUserId: null,
              reason: `carried over from plan #${superseded[0]!.id}`,
            })),
          );
        }
        return {
          id: plan!.id,
          itemCount: allProposed.length,
          reused: false as const,
          supersededId: superseded[0]?.id ?? null,
        };
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
        // The plan this one replaced, so the confirmation can say so (DSH-58).
        superseded_id: result.supersededId,
        repo_ids: repoIds,
        window,
      });
    },
  );

  /** GET /plans — plans with their items, newest first. */
  app.get('/plans', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    // ACTIVE FIRST, then the archived history (W20-09, UX_TODO DSH-58). The
    // list used to stop silently at the 20 newest plans of any status, so a
    // team regenerating every sprint lost sight of which plan was current. A
    // superseded plan is archived, and the page folds those away; `truncated`
    // says when there was more than this page holds.
    const PLAN_LIST_LIMIT = 100;
    const planRows = await db
      .select()
      .from(plansSchema.improvementPlans)
      .where(eq(plansSchema.improvementPlans.workspaceId, workspaceId))
      .orderBy(
        sql`case when ${plansSchema.improvementPlans.status} = 'active' then 0 else 1 end`,
        desc(plansSchema.improvementPlans.createdAt),
        desc(plansSchema.improvementPlans.id),
      )
      .limit(PLAN_LIST_LIMIT + 1);
    const truncated = planRows.length > PLAN_LIST_LIMIT;
    if (truncated) planRows.pop();

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
      truncated,
      items: planRows.map((p) => ({
        id: p.id,
        window: p.window,
        repo_ids: p.repoIds,
        catalog_version: p.catalogVersion,
        status: p.status,
        created_at: p.createdAt.toISOString(),
        created_from_report_id: p.createdFromReportId,
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
