import { describe, expect, it } from 'vitest';
import { computeDirectoryOwnership, computeOwnership } from './ownership.js';
import type { OwnershipTouch } from './ownership.js';
import {
  OWNERSHIP_60_30_10,
  OWNERSHIP_85_15,
  OWNERSHIP_AS_OF,
} from '../../fixtures/ownership/basic.js';

describe('computeOwnership (METRICS.md §1 M3)', () => {
  it('60/30/10 fixture: busFactor 1, no single_owner flag (0.60 < 0.80)', () => {
    const result = computeOwnership(OWNERSHIP_60_30_10, OWNERSHIP_AS_OF);
    expect(result.totalLinesChanged).toBe(100);
    expect(result.linesChangedByAuthor).toEqual({ alice: 60, bob: 30, carol: 10 });
    expect(result.topShare).toBeCloseTo(0.6, 5);
    expect(result.busFactor).toBe(1);
    expect(result.singleOwner).toBe(false);
  });

  it('85/15 fixture: single_owner flagged (topShare >= 0.80)', () => {
    const result = computeOwnership(OWNERSHIP_85_15, OWNERSHIP_AS_OF);
    expect(result.topShare).toBeCloseTo(0.85, 5);
    expect(result.busFactor).toBe(1);
    expect(result.singleOwner).toBe(true);
  });

  it('busFactor sums authors desc until >=50% is covered', () => {
    const evenSplit: OwnershipTouch[] = [
      {
        authorLogin: 'alice',
        path: 'f.ts',
        additions: 30,
        deletions: 0,
        touchedAt: '2026-06-01T00:00:00Z',
        parentShaCount: 1,
        superseded: false,
      },
      {
        authorLogin: 'bob',
        path: 'f.ts',
        additions: 30,
        deletions: 0,
        touchedAt: '2026-06-01T00:00:00Z',
        parentShaCount: 1,
        superseded: false,
      },
      {
        authorLogin: 'carol',
        path: 'f.ts',
        additions: 40,
        deletions: 0,
        touchedAt: '2026-06-01T00:00:00Z',
        parentShaCount: 1,
        superseded: false,
      },
    ];
    // desc order: carol(40) alone = 40% (<50%) -> +bob(30) = 70% (>=50%) -> busFactor 2
    expect(computeOwnership(evenSplit, OWNERSHIP_AS_OF).busFactor).toBe(2);
  });

  it('excludes touches outside the fixed trailing 365d window, even if window param W would include them', () => {
    const staleTouch: OwnershipTouch = {
      authorLogin: 'dave',
      path: 'f.ts',
      additions: 1000,
      deletions: 1000,
      touchedAt: '2024-01-01T00:00:00Z', // >365d before OWNERSHIP_AS_OF
      parentShaCount: 1,
      superseded: false,
    };
    const result = computeOwnership([...OWNERSHIP_60_30_10, staleTouch], OWNERSHIP_AS_OF);
    expect(result.linesChangedByAuthor.dave).toBeUndefined();
    expect(result.totalLinesChanged).toBe(100);
  });

  it('excludes bot, merge-commit, and superseded touches', () => {
    const excludedTouches: OwnershipTouch[] = [
      {
        authorLogin: 'renovate[bot]',
        path: 'f.ts',
        additions: 500,
        deletions: 500,
        touchedAt: '2026-06-15T00:00:00Z',
        parentShaCount: 1,
        superseded: false,
      },
      {
        authorLogin: 'alice',
        path: 'f.ts',
        additions: 500,
        deletions: 500,
        touchedAt: '2026-06-15T00:00:00Z',
        parentShaCount: 2, // merge commit
        superseded: false,
      },
      {
        authorLogin: 'alice',
        path: 'f.ts',
        additions: 500,
        deletions: 500,
        touchedAt: '2026-06-15T00:00:00Z',
        parentShaCount: 1,
        superseded: true, // tombstoned
      },
    ];
    const result = computeOwnership([...OWNERSHIP_60_30_10, ...excludedTouches], OWNERSHIP_AS_OF);
    expect(result.totalLinesChanged).toBe(100);
  });

  it('returns null topShare and 0 busFactor when there is no eligible activity', () => {
    const result = computeOwnership([], OWNERSHIP_AS_OF);
    expect(result.topShare).toBeNull();
    expect(result.busFactor).toBe(0);
    expect(result.singleOwner).toBe(false);
  });
});

describe('computeDirectoryOwnership (recursive sum of files)', () => {
  it('sums every file under the directory prefix, and only that prefix', () => {
    const touches: OwnershipTouch[] = [
      {
        authorLogin: 'alice',
        path: 'src/a.ts',
        additions: 10,
        deletions: 0,
        touchedAt: '2026-06-01T00:00:00Z',
        parentShaCount: 1,
        superseded: false,
      },
      {
        authorLogin: 'bob',
        path: 'src/nested/b.ts',
        additions: 20,
        deletions: 0,
        touchedAt: '2026-06-01T00:00:00Z',
        parentShaCount: 1,
        superseded: false,
      },
      {
        authorLogin: 'carol',
        path: 'src-other/c.ts', // must NOT match prefix "src/"
        additions: 1000,
        deletions: 0,
        touchedAt: '2026-06-01T00:00:00Z',
        parentShaCount: 1,
        superseded: false,
      },
    ];
    const result = computeDirectoryOwnership(touches, 'src', OWNERSHIP_AS_OF);
    expect(result.totalLinesChanged).toBe(30);
    expect(result.linesChangedByAuthor).toEqual({ alice: 10, bob: 20 });
  });
});
