import type { ChurnFileTouch } from '../../src/metrics/churn.js';

// Hand-computable churn fixture (METRICS.md §1 M1 acceptance: "fixture repo
// reproduces gross/net/rework to the line"). Two independent touch chains:
//
// Chain A (`file.ts`): c1 -> c2 (10d gap, rework) -> c3 (25d gap, not
// rework), plus three excluded touches (bot/merge/superseded) that must
// contribute nothing.
// Chain B (`old.ts` renamed to `new.ts`): c7 -> c8 (9d gap, rework via the
// rename chain).
export const CHURN_FIXTURE_TOUCHES: readonly ChurnFileTouch[] = [
  {
    sha: 'c1',
    authorLogin: 'alice',
    parentShaCount: 1,
    superseded: false,
    path: 'file.ts',
    additions: 50,
    deletions: 10,
    touchedAt: '2026-06-01T00:00:00Z',
  },
  {
    sha: 'c2',
    authorLogin: 'alice',
    parentShaCount: 1,
    superseded: false,
    path: 'file.ts',
    additions: 20,
    deletions: 10,
    touchedAt: '2026-06-11T00:00:00Z', // 10 days after c1 -> rework
  },
  {
    sha: 'c3',
    authorLogin: 'bob',
    parentShaCount: 1,
    superseded: false,
    path: 'file.ts',
    additions: 5,
    deletions: 5,
    touchedAt: '2026-07-06T00:00:00Z', // 25 days after c2 -> not rework
  },
  {
    sha: 'c4',
    authorLogin: 'renovate[bot]',
    parentShaCount: 1,
    superseded: false,
    path: 'file.ts',
    additions: 100,
    deletions: 100,
    touchedAt: '2026-06-05T00:00:00Z', // excluded: bot
  },
  {
    sha: 'c5',
    authorLogin: 'alice',
    parentShaCount: 2,
    superseded: false,
    path: 'file.ts',
    additions: 200,
    deletions: 200,
    touchedAt: '2026-06-06T00:00:00Z', // excluded: merge commit
  },
  {
    sha: 'c6',
    authorLogin: 'alice',
    parentShaCount: 1,
    superseded: true,
    path: 'file.ts',
    additions: 300,
    deletions: 300,
    touchedAt: '2026-06-07T00:00:00Z', // excluded: superseded (tombstoned)
  },
  {
    sha: 'c7',
    authorLogin: 'alice',
    parentShaCount: 1,
    superseded: false,
    path: 'old.ts',
    additions: 10,
    deletions: 0,
    touchedAt: '2026-05-01T00:00:00Z',
  },
  {
    sha: 'c8',
    authorLogin: 'alice',
    parentShaCount: 1,
    superseded: false,
    path: 'new.ts',
    previousPath: 'old.ts',
    additions: 5,
    deletions: 5,
    touchedAt: '2026-05-10T00:00:00Z', // 9 days after c7 -> rework via rename chain
  },
];

// Hand-computed expected totals across BOTH chains combined.
export const CHURN_FIXTURE_EXPECTED = {
  gross: 120, // fileA: 60+30+10=100; fileB (rename chain): 10+10=20
  net: 60, // fileA: 40+10+0=50; fileB: 10+0=10
  rework: 40, // fileA: c2's 30 (c3's 10 excluded, gap>=21d); fileB: c8's 10
} as const;

export const CHURN_FIXTURE_EXPECTED_CHAIN_B = {
  gross: 20,
  net: 10,
  rework: 10,
} as const;
