import { and, desc, eq, inArray } from 'drizzle-orm';
import { plans as plansSchema, read, type Database } from '@repopulse/shared';
import { evaluateCriterion, verifyTransition, type MetricSet, type VerifyCriterion } from '@repopulse/insights';
import type { Job } from 'bullmq';

// Nightly plans.verify (W5-06, IMPROVEMENT_PLANS.md §3, FR-PLANS-3).
//
// The differentiator: a plan item closes itself when the number it named
// actually moved, and reopens when it comes undone. No LLM is involved and none
// should be — "did M5 stay above 0.8" is arithmetic, and asking a model would
// make the answer unreproducible.

export interface PlansVerifyDeps {
  db: Database;
}

async function metricsForPlan(
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
    if (set[r.metricKey]) continue;
    set[r.metricKey] = {
      value: r.value === null ? null : Number(r.value),
      dims: (r.dims ?? {}) as Record<string, unknown>,
    };
  }
  return set;
}

export interface VerifySummary {
  checked: number;
  done: number;
  regressed: number;
}

export function plansVerifyProcessor(deps: PlansVerifyDeps) {
  return async function process(_job: Job): Promise<VerifySummary> {
    const summary: VerifySummary = { checked: 0, done: 0, regressed: 0 };

    // Only items a verifier may act on. proposed and dismissed are human
    // states: the nightly job never accepts work on someone's behalf and never
    // resurrects something a person dismissed.
    const items = await deps.db
      .select()
      .from(plansSchema.planItems)
      .where(inArray(plansSchema.planItems.status, ['accepted', 'in_progress', 'done', 'regressed']));

    // Metrics are read once per (workspace, window, scope) rather than per
    // item: a plan with a dozen items would otherwise issue a dozen identical
    // snapshot queries.
    const planCache = new Map<number, MetricSet>();

    for (const item of items) {
      const [plan] = await deps.db
        .select()
        .from(plansSchema.improvementPlans)
        .where(eq(plansSchema.improvementPlans.id, item.planId))
        .limit(1);
      if (!plan) continue;

      let metrics = planCache.get(plan.id);
      if (!metrics) {
        metrics = await metricsForPlan(deps.db, plan.workspaceId, plan.repoIds, plan.window);
        planCache.set(plan.id, metrics);
      }

      const criterion = item.verifyCriterion as unknown as VerifyCriterion;
      const outcome = evaluateCriterion(metrics, criterion);
      summary.checked += 1;

      const decision = verifyTransition(
        item.status as Parameters<typeof verifyTransition>[0],
        outcome,
        criterion,
      );
      if (!decision) continue;

      const now = new Date();
      await deps.db
        .update(plansSchema.planItems)
        .set({ status: decision.next, verifiedAt: now, statusChangedAt: now })
        .where(eq(plansSchema.planItems.id, item.id));

      // actorUserId null = the verifier, not a person. Without that distinction
      // an automatic reopen is indistinguishable from a colleague reopening it.
      await deps.db.insert(plansSchema.planItemEvents).values({
        workspaceId: item.workspaceId,
        planItemId: item.id,
        fromStatus: item.status,
        toStatus: decision.next,
        actorUserId: null,
        reason: decision.reason,
      });

      if (decision.next === 'done') summary.done += 1;
      if (decision.next === 'regressed') summary.regressed += 1;
    }

    return summary;
  };
}
