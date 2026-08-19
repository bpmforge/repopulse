import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import { plans as plansSchema, type Database } from '@repopulse/shared';
import type { ReportSection } from '../types/index.js';

// The plan section every report closes with (W5-07, IMPROVEMENT_PLANS.md §5,
// FR-PLANS-6).
//
// A report that only describes problems is a report people read once. The
// difference between this and a dashboard screenshot is that it ends with what
// was agreed and what actually moved since the last one.

export interface PlanSectionParams {
  workspaceId: number;
  snapshotAt: Date;
  /** The previous same-scope report's pin, when there is one. */
  previousSnapshotAt: Date | null;
}

export async function planSections(
  db: Database,
  params: PlanSectionParams,
): Promise<ReportSection[]> {
  const activePlans = await db
    .select()
    .from(plansSchema.improvementPlans)
    .where(
      and(
        eq(plansSchema.improvementPlans.workspaceId, params.workspaceId),
        eq(plansSchema.improvementPlans.status, 'active'),
        // Only plans that existed when the report was pinned: a plan created
        // afterwards did not inform this report and must not appear in it.
        lte(plansSchema.improvementPlans.createdAt, params.snapshotAt),
      ),
    )
    .orderBy(desc(plansSchema.improvementPlans.createdAt))
    .limit(1);

  if (activePlans.length === 0) {
    return [
      {
        kind: 'no_data',
        id: 'plan',
        reason:
          'No improvement plan exists for this workspace yet. Generate one from the Plans page to close future reports with agreed actions and their verification status.',
      },
    ];
  }

  const plan = activePlans[0]!;
  const items = await db
    .select()
    .from(plansSchema.planItems)
    .where(
      and(
        eq(plansSchema.planItems.workspaceId, params.workspaceId),
        eq(plansSchema.planItems.planId, plan.id),
      ),
    )
    .orderBy(plansSchema.planItems.rank);

  const open = items.filter((i) => ['proposed', 'accepted', 'in_progress', 'regressed'].includes(i.status));

  const sections: ReportSection[] = [
    open.length > 0
      ? {
          kind: 'table',
          id: 'plan_open_items',
          columns: ['#', 'Recommendation', 'Effort', 'Status'],
          rows: open.map((i) => [i.rank, i.recommendation, i.effort, i.status]),
        }
      : {
          kind: 'no_data',
          id: 'plan_open_items',
          reason:
            'Every item on the current plan is verified or dismissed — there is nothing outstanding for this scope.',
        },
  ];

  // Movement since the previous same-scope report, computed from the audit
  // trail between the two pins rather than from current status: "3 items are
  // done" says nothing about whether they were done last month too.
  if (params.previousSnapshotAt) {
    const events = await db
      .select()
      .from(plansSchema.planItemEvents)
      .where(
        and(
          eq(plansSchema.planItemEvents.workspaceId, params.workspaceId),
          inArray(
            plansSchema.planItemEvents.planItemId,
            items.length > 0 ? items.map((i) => i.id) : [-1],
          ),
          gt(plansSchema.planItemEvents.createdAt, params.previousSnapshotAt),
          lte(plansSchema.planItemEvents.createdAt, params.snapshotAt),
        ),
      )
      .orderBy(plansSchema.planItemEvents.createdAt);

    sections.push(
      events.length > 0
        ? {
            kind: 'table',
            id: 'plan_movement',
            columns: ['When', 'Item', 'From', 'To', 'Why'],
            rows: events.map((e) => [
              e.createdAt.toISOString().slice(0, 10),
              items.find((i) => i.id === e.planItemId)?.recommendation ?? String(e.planItemId),
              e.fromStatus,
              e.toStatus,
              // Automatic transitions carry the criterion that fired; human
              // ones say so. Both matter to a reader asking "who decided this".
              e.actorUserId === null ? (e.reason ?? 'automatic') : 'changed by a person',
            ]),
          }
        : {
            kind: 'no_data',
            id: 'plan_movement',
            reason: 'No plan items changed status since the previous report for this scope.',
          },
    );
  } else {
    sections.push({
      kind: 'no_data',
      id: 'plan_movement',
      reason:
        'This is the first report for this scope, so there is no previous report to compare plan movement against.',
    });
  }

  return sections;
}
