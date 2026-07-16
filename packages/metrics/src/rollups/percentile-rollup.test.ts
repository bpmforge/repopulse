import { describe, expect, it } from 'vitest';
import { rollupPercentileMetric } from './percentile-rollup.js';

describe('rollupPercentileMetric (FR-METRICS-14 — pooled, not averaged)', () => {
  it("pooled p90 is NOT the mean of each repo's own p90 (the whole point of pooling)", () => {
    const perRepo = [
      { repoId: 1, samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, // repo p90 = 9
      { repoId: 2, samples: [100] }, // repo p90 = 100 (single value)
    ];
    // naive (WRONG) approach: mean(9, 100) = 54.5
    const naiveMeanOfRepoP90s = (9 + 100) / 2;

    const result = rollupPercentileMetric(perRepo);
    // pooled sample: [1..10, 100] (11 values) -> nearest-rank p90:
    // rank = ceil(0.9*11) = 10 -> 10th smallest = 10.
    expect(result.p90Value).toBe(10);
    expect(result.p90Value).not.toBe(naiveMeanOfRepoP90s);
  });

  it('computes the pooled median too', () => {
    const perRepo = [
      { repoId: 1, samples: [10, 20] },
      { repoId: 2, samples: [30] },
    ];
    // pooled: [10,20,30], median (nearest-rank p50 of 3) = 2nd smallest = 20
    expect(rollupPercentileMetric(perRepo).medianValue).toBe(20);
  });

  it('honors the active repo-set filter - excluded repos contribute zero samples', () => {
    const perRepo = [
      { repoId: 1, samples: [1, 2, 3] },
      { repoId: 2, samples: [1000] }, // excluded by the filter below
    ];
    const result = rollupPercentileMetric(perRepo, [1]);
    expect(result.medianValue).toBe(2); // only repo 1's samples pooled
    expect(result.p90Value).toBe(3);
  });

  it('returns null for an empty or all-filtered-out input', () => {
    expect(rollupPercentileMetric([])).toEqual({ medianValue: null, p90Value: null });
    expect(rollupPercentileMetric([{ repoId: 1, samples: [1, 2] }], [999])).toEqual({
      medianValue: null,
      p90Value: null,
    });
  });
});
