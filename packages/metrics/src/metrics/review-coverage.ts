import { ratio } from '../engine/ratio.js';

// METRICS.md §1 M7's exact bucket thresholds - defined here (needed by M6's
// drill-down sizeBucket field) and exported so W3-06 (PR size distribution)
// reuses the same single source of truth rather than re-deriving it.
export type PrSizeBucket = 'XS' | 'S' | 'M' | 'L' | 'XL';

export function prSizeBucket(gross: number): PrSizeBucket {
  if (gross < 10) return 'XS';
  if (gross < 100) return 'S';
  if (gross < 500) return 'M';
  if (gross < 1000) return 'L';
  return 'XL';
}

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

export interface ReviewCoverageReview {
  reviewerLogin: string;
  state: ReviewState;
  /** For COMMENTED reviews: false = an empty/rubber-stamp comment, never covers (METRICS.md §1 M5). */
  hasContent: boolean;
}

export interface ReviewCoveragePr {
  number: number;
  authorLogin: string;
  isBot: boolean;
  /** null = not merged - excluded from both numerator and denominator. */
  mergedAt: string | null;
  mergedByLogin: string | null;
  additions: number;
  deletions: number;
  reviews: readonly ReviewCoverageReview[];
}

export interface ReviewCoverageDrillDownEntry {
  pr: number;
  author: string;
  merger: string | null;
  sizeBucket: PrSizeBucket;
  mergedAt: string;
}

export interface ReviewCoverageResult {
  merged: number;
  covered: number;
  /** M5 = covered/merged; null on zero eligible PRs, never 0. */
  m5: number | null;
  /** M6 = 1 - M5; null under the same zero-denominator condition as M5. */
  m6: number | null;
  /** Reconciles exactly with merged - covered (asserted in tests). */
  uncoveredDrillDown: readonly ReviewCoverageDrillDownEntry[];
}

// DISMISSED is deliberately excluded - a dismissed review's opinion no
// longer stands, so it can't satisfy "completed non-author review".
const QUALIFYING_STATES: ReadonlySet<ReviewState> = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
]);

function isCovered(pr: ReviewCoveragePr): boolean {
  return pr.reviews.some(
    (r) =>
      r.reviewerLogin !== pr.authorLogin && // self-review never counts
      QUALIFYING_STATES.has(r.state) &&
      (r.state !== 'COMMENTED' || r.hasContent),
  );
}

/** METRICS.md §1 M5/M6: covered/merged (bot PRs and unmerged PRs excluded entirely). */
export function computeReviewCoverage(prs: readonly ReviewCoveragePr[]): ReviewCoverageResult {
  const eligible = prs.filter((p) => p.mergedAt !== null && !p.isBot);
  const covered = eligible.filter(isCovered);
  const uncovered = eligible.filter((p) => !isCovered(p));

  const m5Result = ratio(covered.length, eligible.length);
  const m6 = m5Result.value === null ? null : 1 - m5Result.value;

  return {
    merged: eligible.length,
    covered: covered.length,
    m5: m5Result.value,
    m6,
    uncoveredDrillDown: uncovered.map((p) => ({
      pr: p.number,
      author: p.authorLogin,
      merger: p.mergedByLogin,
      sizeBucket: prSizeBucket(p.additions + p.deletions),
      mergedAt: p.mergedAt as string,
    })),
  };
}
