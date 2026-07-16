// METRICS.md §4 E3 — M5/M6 worked example: 10 merged PRs, 6 with non-author
// reviews, 1 self-approved only (uncovered), 2 with zero reviews, 1 bot-
// authored (excluded entirely). Consumed by whichever ticket implements
// M5/M6 (W3-05); this harness only guarantees the raw PR set loads with the
// documented composition.
export interface ReviewCoverageFixturePr {
  number: number;
  authorLogin: string;
  isBot: boolean;
  /** true when the PR has >=1 completed non-author review (covered). */
  hasNonAuthorReview: boolean;
  /** true when the only "approval" on the PR is the author approving their own PR. */
  isSelfApprovedOnly: boolean;
}

export const E3_REVIEW_COVERAGE_FIXTURE: readonly ReviewCoverageFixturePr[] = [
  ...Array.from({ length: 6 }, (_, i) => ({
    number: i + 1,
    authorLogin: `dev${i + 1}`,
    isBot: false,
    hasNonAuthorReview: true,
    isSelfApprovedOnly: false,
  })),
  {
    number: 7,
    authorLogin: 'dev7',
    isBot: false,
    hasNonAuthorReview: false,
    isSelfApprovedOnly: true,
  },
  {
    number: 8,
    authorLogin: 'dev8',
    isBot: false,
    hasNonAuthorReview: false,
    isSelfApprovedOnly: false,
  },
  {
    number: 9,
    authorLogin: 'dev9',
    isBot: false,
    hasNonAuthorReview: false,
    isSelfApprovedOnly: false,
  },
  {
    number: 10,
    authorLogin: 'renovate[bot]',
    isBot: true,
    hasNonAuthorReview: false,
    isSelfApprovedOnly: false,
  },
];

// Expected M5/M6 result per METRICS.md §4 E3: denominator excludes the bot
// PR (#10) -> 9; covered = the 6 with a non-author review (self-approval
// and zero-review PRs are NOT covered) -> M5 = 6/9 = 0.667, M6 = 0.333.
export const E3_EXPECTED = {
  denominator: 9,
  covered: 6,
  m5: 6 / 9,
  m6: 1 - 6 / 9,
} as const;
