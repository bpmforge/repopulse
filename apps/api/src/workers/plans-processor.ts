import { and, eq, inArray } from 'drizzle-orm';
import { plans as plansSchema, type Database } from '@repopulse/shared';
import {
  observeCriterion,
  recordVerification,
  verifyTransition,
  type MetricSet,
  type VerifyCriterion,
} from '@repopulse/insights';
import type { Job } from 'bullmq';
import { scopedMetrics } from '../lib/scope-metrics.js';

// Nightly plans.verify (W5-06, IMPROVEMENT_PLANS.md §3, FR-PLANS-3).
//
// The differentiator: a plan item closes itself when the number it named
// actually moved, and reopens when it comes undone. No LLM is involved and none
// should be — "did M5 stay above 0.8" is arithmetic, and asking a model would
// make the answer unreproducible.
//
// W17-25: every check is RECORDED on the item (outcome + the number seen), so
// a screen can say "unknown: not measured" rather than nothing; a missing
// measurement moves nothing; and a transition is written with a guard on the
// status that was read, so two runs — or one run racing its retry — cannot
// write the same event twice.

export interface PlansVerifyDeps {
  db: Database;
}

export interface VerifySummary {
  checked: number;
  /** Checks whose metric could not be read — recorded, never acted on. */
  unknown: number;
  done: number;
  regressed: number;
}

export function plansVerifyProcessor(deps: PlansVerifyDeps) {
  return async function process(_job: Job): Promise<VerifySummary> {
    const summary: VerifySummary = { checked: 0, unknown: 0, done: 0, regressed: 0 };

    // Only items a verifier may act on. proposed and dismissed are human
    // states: the nightly job never accepts work on someone's behalf and never
    // resurrects something a person dismissed.
    const items = await deps.db
      .select()
      .from(plansSchema.planItems)
      .where(
        inArray(plansSchema.planItems.status, ['accepted', 'in_progress', 'done', 'regressed']),
      );

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
      // An archived plan is history (W20-09, UX_TODO DSH-58): a regeneration
      // carried its decided items into the plan that superseded it, and
      // verifying both copies would write two histories for one piece of work.
      if (!plan || plan.status !== 'active') continue;

      let metrics = planCache.get(plan.id);
      if (!metrics) {
        // The plan's SET of repositories, combined — the same reader
        // generation uses (W20-09, UX_TODO DSH-86), so the number that raised
        // an item is the number that closes it. It used to be whichever
        // repository's row was computed last.
        metrics = await scopedMetrics(deps.db, plan.workspaceId, plan.repoIds, plan.window);
        planCache.set(plan.id, metrics);
      }

      const criterion = item.verifyCriterion as unknown as VerifyCriterion;
      const { outcome, observed } = observeCriterion(metrics, criterion);
      summary.checked += 1;
      if (outcome === 'unknown') summary.unknown += 1;

      const now = new Date();
      const evidence = recordVerification(item.evidence, {
        outcome,
        observed,
        checkedAt: now.toISOString(),
      });
      // verified_at means "measured": an unknown check leaves it alone, so a
      // done item keeps the date its number was last actually seen.
      const measured = outcome === 'unknown' ? {} : { verifiedAt: now };

      // Guarded on the status that was read: if a person (or another run)
      // moved the item since, this write matches nothing and is dropped.
      const unchanged = and(
        eq(plansSchema.planItems.id, item.id),
        eq(plansSchema.planItems.status, item.status),
      );

      const decision = verifyTransition(
        item.status as Parameters<typeof verifyTransition>[0],
        outcome,
        criterion,
        observed,
      );
      if (!decision) {
        await deps.db
          .update(plansSchema.planItems)
          .set({ evidence, ...measured })
          .where(unchanged);
        continue;
      }

      // The status write and its history row are ONE transaction, and the
      // event is written only when the guarded update actually changed a
      // row — which is what makes a concurrent second run a no-op rather
      // than a duplicate.
      const applied = await deps.db.transaction(async (tx) => {
        const updated = await tx
          .update(plansSchema.planItems)
          .set({
            status: decision.next,
            evidence,
            verifiedAt: now,
            statusChangedAt: now,
            // The verifier is not a person.
            statusChangedBy: null,
          })
          .where(unchanged)
          .returning({ id: plansSchema.planItems.id });
        if (updated.length === 0) return false;

        // actorUserId null = the verifier, not a person. Without that
        // distinction an automatic reopen is indistinguishable from a
        // colleague reopening it.
        await tx.insert(plansSchema.planItemEvents).values({
          workspaceId: item.workspaceId,
          planItemId: item.id,
          fromStatus: item.status,
          toStatus: decision.next,
          actorUserId: null,
          reason: decision.reason,
        });
        return true;
      });
      if (!applied) continue;

      if (decision.next === 'done') summary.done += 1;
      if (decision.next === 'regressed') summary.regressed += 1;
    }

    return summary;
  };
}
