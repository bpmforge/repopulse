import type { IssueThroughputInput } from '../../src/metrics/issues.js';

// Window = June 2026; asOf = end of June. Hand-computable per METRICS.md §1
// M10: opened=2 (#1 created 06-01, #4 created 06-10 - #2 created in May
// doesn't count), closed=2 (#1's one close + #2's SECOND close; #2's first
// close in May is out of window - "reopen+reclose = 2 closes" is exercised
// here since #2 has two close events total, only one of which is in W),
// medianTimeToCloseDays = median([14, 19]) = 14, open-age (#4 only) = 20d.
export const ISSUES_WINDOW_START = new Date('2026-06-01T00:00:00Z');
export const ISSUES_WINDOW_END = new Date('2026-06-30T00:00:00Z');
export const ISSUES_AS_OF = ISSUES_WINDOW_END;

export const ISSUES_FIXTURE: readonly IssueThroughputInput[] = [
  {
    number: 1,
    isPullRequest: false,
    createdAt: '2026-06-01T00:00:00Z',
    isOpenAtSnapshot: false,
    closeEvents: [
      { openPeriodStartedAt: '2026-06-01T00:00:00Z', closedAt: '2026-06-15T00:00:00Z' }, // 14d
    ],
  },
  {
    number: 2,
    isPullRequest: false,
    createdAt: '2026-05-01T00:00:00Z', // outside the June window
    isOpenAtSnapshot: false,
    closeEvents: [
      { openPeriodStartedAt: '2026-05-01T00:00:00Z', closedAt: '2026-05-10T00:00:00Z' }, // out of window - not counted
      { openPeriodStartedAt: '2026-06-01T00:00:00Z', closedAt: '2026-06-20T00:00:00Z' }, // 19d, in window
    ],
  },
  {
    number: 3,
    isPullRequest: true, // always excluded from M10 (FR-METRICS-10)
    createdAt: '2026-06-01T00:00:00Z',
    isOpenAtSnapshot: false,
    closeEvents: [
      { openPeriodStartedAt: '2026-06-01T00:00:00Z', closedAt: '2026-06-02T00:00:00Z' },
    ],
  },
  {
    number: 4,
    isPullRequest: false,
    createdAt: '2026-06-10T00:00:00Z',
    isOpenAtSnapshot: true, // still open at the snapshot - age = 20d
    closeEvents: [],
  },
];

export const ISSUES_EXPECTED = {
  opened: 2,
  closed: 2,
  medianTimeToCloseDays: 14,
  openAgeDays: [20],
} as const;
