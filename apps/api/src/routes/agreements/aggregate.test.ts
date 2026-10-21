import { describe, expect, it } from 'vitest';
import type { Agreement } from '@repopulse/insights';
import { checkAggregate } from './index.js';

// W20-22 (UX_TODO ADM-59): "Stale pull requests stay under" and "CI pass rate
// stays above" were never checked; aggregateBreached had no caller. Each
// repository in scope is now judged against its current metric, and one with
// no number is "not measured", never "fine".

const stale: Agreement = {
  id: 1,
  kind: 'stale_ceiling',
  threshold: { count: 5 },
  repoIds: [],
  active: true,
};
const ci: Agreement = { id: 2, kind: 'ci_pass_floor', threshold: {}, repoIds: [], active: true };

describe('checkAggregate', () => {
  it('judges every repository when the agreement covers all', () => {
    const values = new Map<number, number | null>([
      [1, 9],
      [2, 3],
    ]);
    expect(checkAggregate(stale, [1, 2, 3], values)).toEqual([
      { repoId: 1, value: 9, breached: true },
      { repoId: 2, value: 3, breached: false },
      { repoId: 3, value: null, breached: null },
    ]);
  });

  it('judges only the chosen repositories, against the default floor', () => {
    const values = new Map<number, number | null>([
      [1, 0.95],
      [2, 0.5],
    ]);
    expect(checkAggregate({ ...ci, repoIds: [2] }, [1, 2], values)).toEqual([
      { repoId: 2, value: 0.5, breached: true },
    ]);
    // A repository with no CI runs has a null pass rate: not measured.
    expect(checkAggregate(ci, [3], new Map([[3, null]]))).toEqual([
      { repoId: 3, value: null, breached: null },
    ]);
  });
});
