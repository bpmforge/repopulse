import { median, nearestRankPercentile } from '../engine/percentiles.js';

// METRICS.md §1 M4. Event kinds cover everything that can move the stages:
// 'comment'/'approval'/'changes_requested' are reviewer actions; 're-request'
// is the PR author re-requesting review; 'dismissed' voids a reviewer's
// most recent approval.
export type CycleEventKind =
  'comment' | 'approval' | 'changes_requested' | 're-request' | 'dismissed';

export interface CycleEvent {
  kind: CycleEventKind;
  actorLogin: string;
  at: string; // ISO
}

export interface CyclePr {
  authorLogin: string;
  isBot: boolean;
  createdAt: string;
  /** null = not merged - only merged, non-bot PRs count toward cycle-time (METRICS.md §1 M4). */
  mergedAt: string | null;
  events: readonly CycleEvent[];
}

export interface CycleStageDurationsHours {
  /** null only for a merged PR with zero reviews - it contributes solely to e2e. */
  openToFirstReview: number | null;
  firstReviewToApproved: number | null;
  approvedToMerged: number | null;
  e2e: number;
}

function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60);
}

const REVIEW_KINDS: readonly CycleEventKind[] = ['comment', 'approval', 'changes_requested'];

/**
 * METRICS.md §1 M4 per-PR stage durations. Returns null for bot-authored or
 * unmerged PRs (excluded entirely, not just zeroed).
 *
 * Dismissal handling is a documented simplification: an approval is voided
 * if that SAME reviewer has any 'dismissed' event at all (not necessarily
 * targeting that specific approval) - the flat event list here carries no
 * per-review identity to link a dismissal to one particular prior approval.
 * Exact for the common case (one approval per reviewer); a reviewer who
 * approves, gets dismissed, then re-approves would need richer event data
 * than this shape carries.
 */
export function computeCycleStages(pr: CyclePr): CycleStageDurationsHours | null {
  if (pr.isBot || !pr.mergedAt) return null;

  const created = new Date(pr.createdAt);
  const merged = new Date(pr.mergedAt);
  const e2e = hoursBetween(created, merged);

  const reviewEvents = pr.events
    .filter((e) => e.actorLogin !== pr.authorLogin && REVIEW_KINDS.includes(e.kind))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  if (reviewEvents.length === 0) {
    // METRICS.md §1 M4: zero-review merged PRs contribute only to e2e.
    return { openToFirstReview: null, firstReviewToApproved: null, approvedToMerged: null, e2e };
  }

  const firstReview = reviewEvents[0] as CycleEvent;
  const openToFirstReview = hoursBetween(created, new Date(firstReview.at));

  const reRequests = pr.events
    .filter((e) => e.kind === 're-request')
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const lastReRequest = reRequests[reRequests.length - 1];
  const approvalReferenceTime = lastReRequest
    ? new Date(lastReRequest.at)
    : new Date(firstReview.at);

  const dismissedActors = new Set(
    pr.events.filter((e) => e.kind === 'dismissed').map((e) => e.actorLogin),
  );
  const approval = pr.events
    .filter(
      (e) =>
        e.kind === 'approval' &&
        e.actorLogin !== pr.authorLogin &&
        new Date(e.at) > approvalReferenceTime &&
        !dismissedActors.has(e.actorLogin),
    )
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())[0];

  return {
    openToFirstReview,
    firstReviewToApproved: approval
      ? hoursBetween(new Date(firstReview.at), new Date(approval.at))
      : null,
    approvedToMerged: approval ? hoursBetween(new Date(approval.at), merged) : null,
    e2e,
  };
}

export interface StagePercentiles {
  median: number | null;
  p90: number | null;
}

export interface CycleStagePercentiles {
  openToFirstReview: StagePercentiles;
  firstReviewToApproved: StagePercentiles;
  approvedToMerged: StagePercentiles;
  e2e: StagePercentiles;
}

function stagePercentiles(values: readonly (number | null)[]): StagePercentiles {
  const nums = values.filter((v): v is number => v !== null);
  return { median: median(nums), p90: nearestRankPercentile(nums, 90) };
}

/** METRICS.md §1 M4: median + p90 per stage, nearest-rank, pooled across PRs. */
export function computeCycleStagePercentiles(prs: readonly CyclePr[]): CycleStagePercentiles {
  const results = prs
    .map(computeCycleStages)
    .filter((r): r is CycleStageDurationsHours => r !== null);

  return {
    openToFirstReview: stagePercentiles(results.map((r) => r.openToFirstReview)),
    firstReviewToApproved: stagePercentiles(results.map((r) => r.firstReviewToApproved)),
    approvedToMerged: stagePercentiles(results.map((r) => r.approvedToMerged)),
    e2e: stagePercentiles(results.map((r) => r.e2e)),
  };
}
