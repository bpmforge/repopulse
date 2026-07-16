import type { ReviewCoveragePr } from '../../src/metrics/review-coverage.js';

// METRICS.md §4 E3 — M5/M6 worked example: 10 merged PRs, 6 with
// non-author reviews (covered), 1 self-approved only (uncovered), 2 with
// zero reviews (uncovered), 1 bot-authored (excluded entirely). Expected:
// M5 = 6/9 = 66.7%, M6 = 33.3%.
export const E3_REVIEW_COVERAGE_PRS: readonly ReviewCoveragePr[] = [
  ...Array.from({ length: 6 }, (_, i): ReviewCoveragePr => ({
    number: i + 1,
    authorLogin: `dev${i + 1}`,
    isBot: false,
    mergedAt: '2026-07-05T00:00:00Z',
    mergedByLogin: `dev${i + 1}`,
    additions: 20,
    deletions: 10,
    reviews: [{ reviewerLogin: 'reviewer', state: 'APPROVED', hasContent: true }],
  })),
  {
    number: 7,
    authorLogin: 'dev7',
    isBot: false,
    mergedAt: '2026-07-05T00:00:00Z',
    mergedByLogin: 'dev7',
    additions: 20,
    deletions: 10,
    reviews: [{ reviewerLogin: 'dev7', state: 'APPROVED', hasContent: true }], // self-approval - never counts
  },
  {
    number: 8,
    authorLogin: 'dev8',
    isBot: false,
    mergedAt: '2026-07-05T00:00:00Z',
    mergedByLogin: 'dev8',
    additions: 5,
    deletions: 5,
    reviews: [],
  },
  {
    number: 9,
    authorLogin: 'dev9',
    isBot: false,
    mergedAt: '2026-07-05T00:00:00Z',
    mergedByLogin: 'dev9',
    additions: 5,
    deletions: 5,
    reviews: [],
  },
  {
    number: 10,
    authorLogin: 'renovate[bot]',
    isBot: true,
    mergedAt: '2026-07-05T00:00:00Z',
    mergedByLogin: 'dev1',
    additions: 1,
    deletions: 1,
    reviews: [],
  },
];

export const E3_EXPECTED = {
  merged: 9,
  covered: 6,
  m5: 6 / 9,
  m6: 1 - 6 / 9,
} as const;
