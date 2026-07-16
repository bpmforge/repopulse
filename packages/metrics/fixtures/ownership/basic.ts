import type { OwnershipTouch } from '../../src/metrics/ownership.js';

// METRICS.md §1 M3 worked case: "Fixture 60/30/10 ⇒ busFactor 1 (60 ≥ 50),
// no flag (0.60 < 0.80)". All touches inside the fixed trailing 365d
// window; `asOf` is the reference "now" for that window.
export const OWNERSHIP_AS_OF = new Date('2026-07-07T00:00:00Z');

export const OWNERSHIP_60_30_10: readonly OwnershipTouch[] = [
  {
    authorLogin: 'alice',
    path: 'shared.ts',
    additions: 40,
    deletions: 20,
    touchedAt: '2026-06-01T00:00:00Z',
    parentShaCount: 1,
    superseded: false,
  }, // alice: 60
  {
    authorLogin: 'bob',
    path: 'shared.ts',
    additions: 20,
    deletions: 10,
    touchedAt: '2026-06-02T00:00:00Z',
    parentShaCount: 1,
    superseded: false,
  }, // bob: 30
  {
    authorLogin: 'carol',
    path: 'shared.ts',
    additions: 5,
    deletions: 5,
    touchedAt: '2026-06-03T00:00:00Z',
    parentShaCount: 1,
    superseded: false,
  }, // carol: 10
];

// A second worked case (85/15) that DOES flag single_owner (topShare >= 0.80).
export const OWNERSHIP_85_15: readonly OwnershipTouch[] = [
  {
    authorLogin: 'alice',
    path: 'shared.ts',
    additions: 60,
    deletions: 25,
    touchedAt: '2026-06-01T00:00:00Z',
    parentShaCount: 1,
    superseded: false,
  }, // alice: 85
  {
    authorLogin: 'bob',
    path: 'shared.ts',
    additions: 10,
    deletions: 5,
    touchedAt: '2026-06-02T00:00:00Z',
    parentShaCount: 1,
    superseded: false,
  }, // bob: 15
];
