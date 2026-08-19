// Plans wire contracts (W5-07). Source of truth is apps/api/src/routes/plans.

export type PlanItemStatus =
  | 'proposed'
  | 'accepted'
  | 'in_progress'
  | 'done'
  | 'regressed'
  | 'dismissed';

export interface PlanItem {
  id: number;
  rank: number;
  catalog_id: string;
  source: string;
  recommendation: string;
  effort: 'S' | 'M' | 'L';
  status: PlanItemStatus;
  evidence: Record<string, unknown>;
  verify_criterion: { metricKey: string; op: 'gte' | 'lte'; target: number; windowDays: number; dimPath?: string[] };
  verified_at: string | null;
}

export interface Plan {
  id: number;
  window: string;
  repo_ids: number[];
  catalog_version: string;
  status: string;
  created_at: string;
  items: PlanItem[];
}

/**
 * The verify criterion in words.
 *
 * The stored form is machine-readable ({metricKey, op, target, windowDays}) and
 * unreadable on a card. Rendering the raw JSON would technically be honest and
 * practically useless — someone deciding whether to accept an item needs to
 * know what "done" will mean before they commit to it.
 */
export function criterionInWords(c: PlanItem['verify_criterion']): string {
  const direction = c.op === 'gte' ? 'at least' : 'at most';
  const what = c.dimPath?.length ? `${c.metricKey} ${c.dimPath.join(' ')}` : c.metricKey;
  return `Closes automatically when ${what} stays ${direction} ${c.target} for ${c.windowDays} days.`;
}

/** Progress counts only what a human accepted — proposed work is not progress. */
export function planProgress(plan: Plan): { done: number; total: number; regressed: number } {
  const tracked = plan.items.filter((i) => i.status !== 'dismissed' && i.status !== 'proposed');
  return {
    done: tracked.filter((i) => i.status === 'done').length,
    total: tracked.length,
    regressed: plan.items.filter((i) => i.status === 'regressed').length,
  };
}
