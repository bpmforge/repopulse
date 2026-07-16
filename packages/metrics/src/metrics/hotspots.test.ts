import { describe, expect, it } from 'vitest';
import { computeHotspots } from './hotspots.js';
import { E1_AS_OF, E1_TOUCHES } from '../../fixtures/hotspots/e1.js';
import type { ChurnFileTouch } from './churn.js';

describe('computeHotspots (METRICS.md §1 M2 — reproduces worked example E1 exactly)', () => {
  it('scores api.ts 0.955 and util.ts 0.100, api.ts ranked above util.ts', () => {
    const results = computeHotspots(E1_TOUCHES, E1_AS_OF);
    const api = results.find((r) => r.path === 'api.ts')!;
    const util = results.find((r) => r.path === 'util.ts')!;

    expect(api.gross).toBe(160);
    expect(util.gross).toBe(30);
    expect(api.normChurn).toBe(1.0);
    expect(util.normChurn).toBeCloseTo(0.1875, 4);
    expect(api.daysSince).toBe(2);
    expect(util.daysSince).toBe(27);
    expect(api.decay).toBeCloseTo(0.955, 3);
    expect(util.decay).toBeCloseTo(0.536, 3);
    expect(api.score).toBeCloseTo(0.955, 2);
    expect(util.score).toBeCloseTo(0.1, 2);
    expect(api.score).toBeGreaterThan(util.score);
  });

  it('exposes contributing shas for drill-down (FR-METRICS-2)', () => {
    const results = computeHotspots(E1_TOUCHES, E1_AS_OF);
    const api = results.find((r) => r.path === 'api.ts')!;
    expect(api.contributingShas).toEqual(['sha-api']);
  });

  it('scores a file untouched for a year at approximately zero', () => {
    const oldTouch: ChurnFileTouch = {
      sha: 'sha-old',
      authorLogin: 'alice',
      parentShaCount: 1,
      superseded: false,
      path: 'stale.ts',
      additions: 500,
      deletions: 500,
      touchedAt: '2025-07-07T00:00:00Z', // exactly 365 days before E1_AS_OF
    };
    const results = computeHotspots([oldTouch], E1_AS_OF);
    const stale = results.find((r) => r.path === 'stale.ts')!;
    expect(stale.score).toBeLessThan(0.001);
  });

  it('returns no hotspot entries when every touch is excluded (max gross = 0, no divide-by-zero)', () => {
    const botOnly: ChurnFileTouch[] = [
      {
        sha: 'sha-bot',
        authorLogin: 'renovate[bot]',
        parentShaCount: 1,
        superseded: false,
        path: 'lockfile.json',
        additions: 1000,
        deletions: 1000,
        touchedAt: '2026-07-06T00:00:00Z',
      },
    ];
    expect(computeHotspots(botOnly, E1_AS_OF)).toEqual([]);
  });
});
