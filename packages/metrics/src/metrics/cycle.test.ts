import { describe, expect, it } from 'vitest';
import { computeCycleStagePercentiles, computeCycleStages } from './cycle.js';
import type { CyclePr } from './cycle.js';
import { E2_CYCLE_PR, E2_EXPECTED_HOURS } from '../../fixtures/cycle/e2.js';

describe('computeCycleStages (METRICS.md §1 M4 — reproduces worked example E2 exactly)', () => {
  it('matches the doc: 6h / 27h / 15h / e2e 48h', () => {
    expect(computeCycleStages(E2_CYCLE_PR)).toEqual(E2_EXPECTED_HOURS);
  });

  it('excludes bot-authored PRs entirely (null, not zeroed)', () => {
    expect(computeCycleStages({ ...E2_CYCLE_PR, isBot: true })).toBeNull();
  });

  it('excludes unmerged PRs entirely', () => {
    expect(computeCycleStages({ ...E2_CYCLE_PR, mergedAt: null })).toBeNull();
  });

  it('a merged PR with zero reviews contributes only to e2e', () => {
    const noReviews: CyclePr = {
      authorLogin: 'author',
      isBot: false,
      createdAt: '2026-07-01T09:00:00Z',
      mergedAt: '2026-07-03T09:00:00Z',
      events: [],
    };
    expect(computeCycleStages(noReviews)).toEqual({
      openToFirstReview: null,
      firstReviewToApproved: null,
      approvedToMerged: null,
      e2e: 48,
    });
  });

  it('author-authored events never count as a review (self-comment ignored)', () => {
    const selfCommentOnly: CyclePr = {
      authorLogin: 'author',
      isBot: false,
      createdAt: '2026-07-01T09:00:00Z',
      mergedAt: '2026-07-03T09:00:00Z',
      events: [{ kind: 'comment', actorLogin: 'author', at: '2026-07-01T10:00:00Z' }],
    };
    expect(computeCycleStages(selfCommentOnly)?.openToFirstReview).toBeNull();
  });

  it('a dismissed approval never counts toward firstReview->approved', () => {
    const dismissed: CyclePr = {
      authorLogin: 'author',
      isBot: false,
      createdAt: '2026-07-01T09:00:00Z',
      mergedAt: '2026-07-03T09:00:00Z',
      events: [
        { kind: 'comment', actorLogin: 'alice', at: '2026-07-01T15:00:00Z' },
        { kind: 'approval', actorLogin: 'alice', at: '2026-07-02T09:00:00Z' },
        { kind: 'dismissed', actorLogin: 'alice', at: '2026-07-02T09:30:00Z' },
      ],
    };
    const result = computeCycleStages(dismissed);
    expect(result?.openToFirstReview).toBe(6);
    expect(result?.firstReviewToApproved).toBeNull();
    expect(result?.approvedToMerged).toBeNull();
  });

  it('with no re-request, the approval stage is measured from the first approval after firstReview', () => {
    const noReRequest: CyclePr = {
      authorLogin: 'author',
      isBot: false,
      createdAt: '2026-07-01T09:00:00Z',
      mergedAt: '2026-07-02T09:00:00Z',
      events: [
        { kind: 'comment', actorLogin: 'alice', at: '2026-07-01T10:00:00Z' }, // firstReview: +1h
        { kind: 'approval', actorLogin: 'alice', at: '2026-07-01T13:00:00Z' }, // +3h after firstReview
      ],
    };
    const result = computeCycleStages(noReRequest);
    expect(result?.openToFirstReview).toBe(1);
    expect(result?.firstReviewToApproved).toBe(3);
    expect(result?.approvedToMerged).toBe(20); // 2026-07-01T13:00 -> 2026-07-02T09:00
  });
});

describe('computeCycleStagePercentiles (pooled, nearest-rank)', () => {
  it('pools stage durations across PRs and reports median + p90', () => {
    const prs: CyclePr[] = Array.from({ length: 10 }, (_, i) => ({
      authorLogin: 'author',
      isBot: false,
      createdAt: '2026-07-01T00:00:00Z',
      // explicit UTC offsets - avoids any local-timezone dependency (unlike
      // constructing a local Date and re-serializing it).
      mergedAt: new Date(Date.UTC(2026, 6, 1, i + 1)).toISOString(),
      events: [{ kind: 'comment', actorLogin: 'alice', at: '2026-07-01T00:30:00Z' }],
    }));
    const percentiles = computeCycleStagePercentiles(prs);
    // e2e values are 1..10 hours; nearest-rank p90 of 10 values = 9th smallest = 9.
    expect(percentiles.e2e.p90).toBe(9);
    expect(percentiles.e2e.median).toBe(5);
  });

  it('excludes bot/unmerged PRs from the pool entirely', () => {
    const mixed: CyclePr[] = [
      E2_CYCLE_PR,
      { ...E2_CYCLE_PR, isBot: true },
      { ...E2_CYCLE_PR, mergedAt: null },
    ];
    const percentiles = computeCycleStagePercentiles(mixed);
    expect(percentiles.e2e.median).toBe(E2_EXPECTED_HOURS.e2e);
  });
});
