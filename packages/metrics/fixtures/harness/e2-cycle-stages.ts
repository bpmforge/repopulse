// METRICS.md §4 E2 — M4 cycle-time-stages worked example. Consumed by
// whichever ticket implements M4 (W3-04); this harness only guarantees the
// raw timeline loads with the documented values.
export type CycleStageEventKind = 'comment' | 'approval' | 're-request';

export interface CycleStageEvent {
  kind: CycleStageEventKind;
  actorLogin: string;
  at: string; // ISO 8601
}

export interface CycleStagesFixture {
  prNumber: number;
  authorLogin: string;
  createdAt: string;
  mergedAt: string;
  /** Chronological order, as they'd be read off pr_reviews + activity events. */
  events: readonly CycleStageEvent[];
}

export const E2_CYCLE_STAGES_FIXTURE: CycleStagesFixture = {
  prNumber: 7,
  authorLogin: 'author',
  createdAt: '2026-07-01T09:00:00Z',
  mergedAt: '2026-07-03T09:00:00Z',
  events: [
    { kind: 'comment', actorLogin: 'alice', at: '2026-07-01T15:00:00Z' },
    { kind: 'approval', actorLogin: 'alice', at: '2026-07-02T09:00:00Z' },
    { kind: 're-request', actorLogin: 'author', at: '2026-07-02T10:00:00Z' },
    { kind: 'approval', actorLogin: 'alice', at: '2026-07-02T18:00:00Z' },
  ],
};

// Expected derived stage durations per METRICS.md §4 E2, in hours, for
// downstream tickets to assert against once M4 is implemented. The approval
// that counts is the one AFTER the last re-request (2026-07-02T18:00:00Z),
// not the first approval.
export const E2_EXPECTED_HOURS = {
  openToFirstReview: 6,
  firstReviewToApproved: 27,
  approvedToMerged: 15,
  e2e: 48,
} as const;
