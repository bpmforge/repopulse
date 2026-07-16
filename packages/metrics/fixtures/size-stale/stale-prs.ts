import type { StalePrInput } from '../../src/metrics/stale-prs.js';

// asOf reference date - all fixture rows are dated relative to this.
export const STALE_AS_OF = new Date('2026-07-07T00:00:00Z');

export const STALE_PRS_FIXTURE: readonly StalePrInput[] = [
  {
    number: 1,
    isOpen: true,
    isDraft: false,
    lastActivityAt: '2026-06-29T00:00:00Z', // exactly 8 days ago -> stale (>7)
  },
  {
    number: 2,
    isOpen: true,
    isDraft: false,
    lastActivityAt: '2026-07-01T00:00:00Z', // exactly 6 days ago -> NOT stale
  },
  {
    number: 3,
    isOpen: true,
    isDraft: false,
    lastActivityAt: '2026-06-30T00:00:00Z', // exactly 7 days ago -> NOT stale (boundary, must be > N)
  },
  {
    number: 4,
    isOpen: true,
    isDraft: true,
    lastActivityAt: '2026-06-20T00:00:00Z', // 17 days ago, draft -> stale_drafts, not stale
  },
  {
    number: 5,
    isOpen: false, // closed - never a stale candidate regardless of activity age
    isDraft: false,
    lastActivityAt: '2026-01-01T00:00:00Z',
  },
];
