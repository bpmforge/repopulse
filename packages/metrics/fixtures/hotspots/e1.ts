import type { ChurnFileTouch } from '../../src/metrics/churn.js';

// METRICS.md §4 E1 (repo "demo", W=30d, today=2026-07-07), extended to full
// ChurnFileTouch records (the harness's E1_HOTSPOT_FIXTURE only carries the
// path/additions/deletions/committedAt subset needed to prove fixture
// loading in W3-01 - this ticket needs the full commit-touch shape to
// exercise computeHotspots for real).
export const E1_TOUCHES: readonly ChurnFileTouch[] = [
  {
    sha: 'sha-api',
    authorLogin: 'alice',
    parentShaCount: 1,
    superseded: false,
    path: 'api.ts',
    additions: 120,
    deletions: 40,
    touchedAt: '2026-07-05T00:00:00Z',
  },
  {
    sha: 'sha-util',
    authorLogin: 'alice',
    parentShaCount: 1,
    superseded: false,
    path: 'util.ts',
    additions: 20,
    deletions: 10,
    touchedAt: '2026-06-10T00:00:00Z',
  },
];

export const E1_AS_OF = new Date('2026-07-07T00:00:00Z');
