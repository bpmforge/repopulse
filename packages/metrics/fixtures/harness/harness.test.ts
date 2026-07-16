import { describe, expect, it } from 'vitest';
import { daysBetween } from '../../src/engine/windows.js';
import { ratio } from '../../src/engine/ratio.js';
import {
  E1_EXPECTED,
  loadCycleStagesFixture,
  loadHotspotFixture,
  loadReviewCoverageFixture,
} from './index.js';
import { E2_EXPECTED_HOURS } from './e2-cycle-stages.js';
import { E3_EXPECTED } from './e3-review-coverage.js';

describe('fixture harness — METRICS.md §4 worked examples (W3-01)', () => {
  it('E1 loads the hotspot fixture with the documented inputs', () => {
    const fixture = loadHotspotFixture();
    expect(fixture.repo).toBe('demo');
    expect(fixture.today).toBe('2026-07-07T00:00:00Z');
    expect(fixture.windowDays).toBe(30);
    expect(fixture.touches).toEqual([
      { path: 'api.ts', additions: 120, deletions: 40, committedAt: '2026-07-05T00:00:00Z' },
      { path: 'util.ts', additions: 20, deletions: 10, committedAt: '2026-06-10T00:00:00Z' },
    ]);
  });

  it('E1 daysSince, computed via the shared windows utility, matches the doc (2 / 27)', () => {
    const fixture = loadHotspotFixture();
    const today = new Date(fixture.today);
    const apiTs = fixture.touches.find((t) => t.path === 'api.ts')!;
    const utilTs = fixture.touches.find((t) => t.path === 'util.ts')!;
    expect(daysBetween(new Date(apiTs.committedAt), today)).toBe(E1_EXPECTED.daysSince['api.ts']);
    expect(daysBetween(new Date(utilTs.committedAt), today)).toBe(E1_EXPECTED.daysSince['util.ts']);
  });

  it('E2 loads the cycle-stages fixture with the documented event timeline', () => {
    const fixture = loadCycleStagesFixture();
    expect(fixture.prNumber).toBe(7);
    expect(fixture.createdAt).toBe('2026-07-01T09:00:00Z');
    expect(fixture.mergedAt).toBe('2026-07-03T09:00:00Z');
    expect(fixture.events).toHaveLength(4);
    expect(fixture.events.map((e) => e.kind)).toEqual([
      'comment',
      'approval',
      're-request',
      'approval',
    ]);
  });

  it('E2 stage durations, computed from the raw timeline, match the doc exactly', () => {
    const fixture = loadCycleStagesFixture();
    const hoursBetween = (a: string, b: string) =>
      (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60);

    const firstReview = fixture.events[0]!; // first non-author event
    const lastReRequest = [...fixture.events].reverse().find((e) => e.kind === 're-request')!;
    const approvalAfterLastReRequest = fixture.events.find(
      (e) => e.kind === 'approval' && new Date(e.at) > new Date(lastReRequest.at),
    )!;

    expect(hoursBetween(fixture.createdAt, firstReview.at)).toBe(
      E2_EXPECTED_HOURS.openToFirstReview,
    );
    expect(hoursBetween(firstReview.at, approvalAfterLastReRequest.at)).toBe(
      E2_EXPECTED_HOURS.firstReviewToApproved,
    );
    expect(hoursBetween(approvalAfterLastReRequest.at, fixture.mergedAt)).toBe(
      E2_EXPECTED_HOURS.approvedToMerged,
    );
    expect(hoursBetween(fixture.createdAt, fixture.mergedAt)).toBe(E2_EXPECTED_HOURS.e2e);
  });

  it('E3 loads 10 PRs with the documented composition (6 covered / 1 self-approved / 2 zero-review / 1 bot)', () => {
    const prs = loadReviewCoverageFixture();
    expect(prs).toHaveLength(10);
    expect(prs.filter((p) => p.hasNonAuthorReview)).toHaveLength(6);
    expect(prs.filter((p) => p.isSelfApprovedOnly)).toHaveLength(1);
    expect(prs.filter((p) => p.isBot)).toHaveLength(1);
    expect(
      prs.filter((p) => !p.hasNonAuthorReview && !p.isSelfApprovedOnly && !p.isBot),
    ).toHaveLength(2);
  });

  it('E3 M5/M6, computed via the shared ratio utility, matches the doc exactly (6/9 = 66.7%)', () => {
    const prs = loadReviewCoverageFixture();
    const nonBotPrs = prs.filter((p) => !p.isBot);
    const covered = nonBotPrs.filter((p) => p.hasNonAuthorReview).length;
    const m5 = ratio(covered, nonBotPrs.length);
    expect(m5.numerator).toBe(E3_EXPECTED.covered);
    expect(m5.denominator).toBe(E3_EXPECTED.denominator);
    expect(m5.value).toBeCloseTo(E3_EXPECTED.m5, 5);

    const m6 = ratio(nonBotPrs.length - covered, nonBotPrs.length);
    expect(m6.value).toBeCloseTo(E3_EXPECTED.m6, 5);
  });
});
