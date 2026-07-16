import { describe, expect, it } from 'vitest';
import { computeReviewCoverage, prSizeBucket } from './review-coverage.js';
import type { ReviewCoveragePr } from './review-coverage.js';
import { E3_EXPECTED, E3_REVIEW_COVERAGE_PRS } from '../../fixtures/review/e3.js';

describe('computeReviewCoverage (METRICS.md §1 M5/M6 — reproduces worked example E3 exactly)', () => {
  it('bot PR excluded, self-approval uncovered, M5 = 6/9 = 66.7%', () => {
    const result = computeReviewCoverage(E3_REVIEW_COVERAGE_PRS);
    expect(result.merged).toBe(E3_EXPECTED.merged);
    expect(result.covered).toBe(E3_EXPECTED.covered);
    expect(result.m5).toBeCloseTo(E3_EXPECTED.m5, 5);
  });

  it('M6 = 1 - M5', () => {
    const result = computeReviewCoverage(E3_REVIEW_COVERAGE_PRS);
    expect(result.m6).toBeCloseTo(E3_EXPECTED.m6, 5);
  });

  it('the drill-down list reconciles exactly with merged - covered (3 uncovered PRs: #7 self-approved, #8/#9 zero-review)', () => {
    const result = computeReviewCoverage(E3_REVIEW_COVERAGE_PRS);
    expect(result.uncoveredDrillDown).toHaveLength(result.merged - result.covered);
    expect(result.uncoveredDrillDown.map((d) => d.pr).sort()).toEqual([7, 8, 9]);
  });

  it('drill-down entries carry pr/author/merger/sizeBucket/mergedAt', () => {
    const result = computeReviewCoverage(E3_REVIEW_COVERAGE_PRS);
    const entry = result.uncoveredDrillDown.find((d) => d.pr === 7)!;
    expect(entry).toEqual({
      pr: 7,
      author: 'dev7',
      merger: 'dev7',
      sizeBucket: 'S', // 20+10=30 lines
      mergedAt: '2026-07-05T00:00:00Z',
    });
  });

  it('a CHANGES_REQUESTED review counts as coverage', () => {
    const pr: ReviewCoveragePr = {
      number: 100,
      authorLogin: 'author',
      isBot: false,
      mergedAt: '2026-07-05T00:00:00Z',
      mergedByLogin: 'author',
      additions: 10,
      deletions: 0,
      reviews: [{ reviewerLogin: 'alice', state: 'CHANGES_REQUESTED', hasContent: true }],
    };
    expect(computeReviewCoverage([pr]).covered).toBe(1);
  });

  it('an empty (no-content) COMMENTED review does not count as coverage', () => {
    const pr: ReviewCoveragePr = {
      number: 101,
      authorLogin: 'author',
      isBot: false,
      mergedAt: '2026-07-05T00:00:00Z',
      mergedByLogin: 'author',
      additions: 10,
      deletions: 0,
      reviews: [{ reviewerLogin: 'alice', state: 'COMMENTED', hasContent: false }],
    };
    expect(computeReviewCoverage([pr]).covered).toBe(0);
  });

  it('a DISMISSED review never counts as coverage', () => {
    const pr: ReviewCoveragePr = {
      number: 102,
      authorLogin: 'author',
      isBot: false,
      mergedAt: '2026-07-05T00:00:00Z',
      mergedByLogin: 'author',
      additions: 10,
      deletions: 0,
      reviews: [{ reviewerLogin: 'alice', state: 'DISMISSED', hasContent: true }],
    };
    expect(computeReviewCoverage([pr]).covered).toBe(0);
  });

  it('returns null M5/M6 when there are zero eligible PRs', () => {
    const result = computeReviewCoverage([]);
    expect(result.m5).toBeNull();
    expect(result.m6).toBeNull();
    expect(result.uncoveredDrillDown).toEqual([]);
  });
});

describe('prSizeBucket (METRICS.md §1 M7 thresholds, reused by M6 drill-down)', () => {
  it('buckets inclusive-lower/exclusive-upper', () => {
    expect(prSizeBucket(0)).toBe('XS');
    expect(prSizeBucket(9)).toBe('XS');
    expect(prSizeBucket(10)).toBe('S');
    expect(prSizeBucket(99)).toBe('S');
    expect(prSizeBucket(100)).toBe('M');
    expect(prSizeBucket(499)).toBe('M');
    expect(prSizeBucket(500)).toBe('L');
    expect(prSizeBucket(999)).toBe('L');
    expect(prSizeBucket(1000)).toBe('XL');
    expect(prSizeBucket(50_000)).toBe('XL');
  });
});
