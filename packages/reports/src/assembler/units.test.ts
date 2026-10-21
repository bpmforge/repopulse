import { describe, expect, it } from 'vitest';
import { ciTableRows, flowTableRows } from './index.js';

// W20-22 (UX_TODO ADM-73): the PR flow and CI tables name each measure in
// words, carry a unit, print ratios as percentages, and split PR size into
// its buckets. No M-ids.

describe('PR flow and CI tables', () => {
  it('names the stage, the statistic and the unit', () => {
    const rows = flowTableRows({
      m4: {
        stages: {
          e2e: { median: 41.234, p90: 120 },
          openToFirstReview: { median: 3, p90: 9 },
          firstReviewToApproved: { median: null, p90: null },
          approvedToMerged: { median: 1.5, p90: 4 },
        },
      },
      m5: 0.8333,
      m6: 0.1667,
      m7: { median: 120, dims: { counts: { XS: 2, S: 5, M: 3, L: 0, XL: 1 } } },
      m8: 4,
    });
    expect(rows).toContainEqual(['Cycle time, open to merge (median)', 41.23, 'hours']);
    expect(rows).toContainEqual(['Review coverage of merged PRs', 83.3, '%']);
    expect(rows).toContainEqual(['Merged without review', 16.7, '%']);
    expect(rows).toContainEqual(['PRs sized XL (1,000 lines or more)', 1, 'PRs']);
    expect(rows).toContainEqual(['Stale open PRs', 4, 'PRs']);
    // A stage with no value is left out rather than printed as 0.
    expect(rows.some((r) => String(r[0]).startsWith('First review to approval'))).toBe(false);
    expect(rows.some((r) => /\bM\d+\b/.test(String(r[0])))).toBe(false);
  });

  it('prints CI rates as percentages and keeps a missing figure null', () => {
    const rows = ciTableRows(0.9, { prPassRate: null, duration: { median: 6.5, p90: 12 } });
    expect(rows[0]).toEqual(['Default-branch pass rate', 90, '%']);
    expect(rows[1]).toEqual(['PR pass rate', null, '%']);
    expect(rows[2]).toEqual(['Run duration (median)', 6.5, 'minutes']);
  });
});
