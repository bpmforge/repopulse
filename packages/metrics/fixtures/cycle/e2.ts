import type { CyclePr } from '../../src/metrics/cycle.js';

// METRICS.md §4 E2 — M4 worked example. PR #7: created 07-01 09:00; alice
// (non-author) COMMENTED 07-01 15:00; alice APPROVED 07-02 09:00; author
// re-requested review 07-02 10:00; alice APPROVED 07-02 18:00; merged
// 07-03 09:00. Expected: openToFirstReview=6h, firstReviewToApproved=27h,
// approvedToMerged=15h, e2e=48h.
export const E2_CYCLE_PR: CyclePr = {
  authorLogin: 'author',
  isBot: false,
  createdAt: '2026-07-01T09:00:00Z',
  mergedAt: '2026-07-03T09:00:00Z',
  events: [
    { kind: 'comment', actorLogin: 'alice', at: '2026-07-01T15:00:00Z' },
    { kind: 'approval', actorLogin: 'alice', at: '2026-07-02T09:00:00Z' },
    { kind: 're-request', actorLogin: 'author', at: '2026-07-02T10:00:00Z' },
    { kind: 'approval', actorLogin: 'alice', at: '2026-07-02T18:00:00Z' },
  ],
};

export const E2_EXPECTED_HOURS = {
  openToFirstReview: 6,
  firstReviewToApproved: 27,
  approvedToMerged: 15,
  e2e: 48,
} as const;
