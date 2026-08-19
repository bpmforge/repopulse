// Working agreements (W5-08, IMPROVEMENT_PLANS.md §4, FR-PLANS-4).
//
// "Artifacts to discuss, never a leaderboard" (N-9, R-5). Every exception names
// a PULL REQUEST, never a person — the list exists so a team can look at four
// specific PRs together, not so anyone can be ranked by how often they appear.
// That constraint is why the row shape below has no author field: it cannot
// leak one because it does not carry one.

export const AGREEMENT_KINDS = [
  'pr_size_max',
  'review_within_hours',
  'no_unreviewed_merge',
  'stale_ceiling',
  'ci_pass_floor',
] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

export interface Agreement {
  id: number;
  kind: AgreementKind;
  threshold: Record<string, unknown>;
  repoIds: number[];
  active: boolean;
}

/** One offending pull request. Team artifacts, not people. */
export interface AgreementException {
  repoId: number;
  prNumber: number;
  title: string;
  /** What made it an exception, in the agreement's own units. */
  observed: number;
  detail: string;
}

export interface PrFact {
  repoId: number;
  number: number;
  title: string;
  additions: number;
  deletions: number;
  reviewCount: number;
  firstReviewHours: number | null;
  mergedAt: Date | null;
}

/** Trailing window for exception lists (§4). */
export const EXCEPTION_WINDOW_DAYS = 14;

function thresholdNumber(a: Agreement, key: string, fallback: number): number {
  const v = a.threshold[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Default thresholds, used when a stored agreement omits its own. */
export const AGREEMENT_DEFAULTS: Record<AgreementKind, { key: string; value: number }> = {
  pr_size_max: { key: 'lines', value: 500 },
  review_within_hours: { key: 'hours', value: 24 },
  no_unreviewed_merge: { key: 'minReviews', value: 1 },
  stale_ceiling: { key: 'count', value: 10 },
  ci_pass_floor: { key: 'rate', value: 0.9 },
};

/**
 * The PRs that breached an agreement in the trailing window.
 *
 * Computed, never stored (§4). A stored exception list drifts: a PR that gets
 * reviewed after the fact would sit in the table as an exception forever, and
 * the team would be discussing something that is no longer true.
 */
export function computeExceptions(agreement: Agreement, prs: readonly PrFact[]): AgreementException[] {
  const def = AGREEMENT_DEFAULTS[agreement.kind];
  const limit = thresholdNumber(agreement, def.key, def.value);
  const scoped = agreement.repoIds.length > 0 ? prs.filter((p) => agreement.repoIds.includes(p.repoId)) : prs;

  switch (agreement.kind) {
    case 'pr_size_max':
      return scoped
        .filter((p) => p.additions + p.deletions > limit)
        .map((p) => ({
          repoId: p.repoId,
          prNumber: p.number,
          title: p.title,
          observed: p.additions + p.deletions,
          detail: `${p.additions + p.deletions} lines changed (agreement: ≤${limit})`,
        }));

    case 'review_within_hours':
      return (
        scoped
          // A PR with NO review yet is not a late review — it is an unreviewed
          // PR, which is a different agreement. Counting it here would double-
          // report the same pull request under two agreements.
          .filter((p) => p.firstReviewHours !== null && p.firstReviewHours > limit)
          .map((p) => ({
            repoId: p.repoId,
            prNumber: p.number,
            title: p.title,
            observed: p.firstReviewHours as number,
            detail: `first review after ${Math.round(p.firstReviewHours as number)}h (agreement: ≤${limit}h)`,
          }))
      );

    case 'no_unreviewed_merge':
      return scoped
        .filter((p) => p.mergedAt !== null && p.reviewCount < limit)
        .map((p) => ({
          repoId: p.repoId,
          prNumber: p.number,
          title: p.title,
          observed: p.reviewCount,
          detail:
            p.reviewCount === 0
              ? 'merged with no review'
              : `merged with ${p.reviewCount} review(s) (agreement: ≥${limit})`,
        }));

    // Aggregate agreements are about a repository-level number, not about
    // individual pull requests, so they have no per-PR exception list. Returning
    // an empty array here is correct and is NOT the same as "no violations" —
    // the caller reports those from the metric, and the UI says so.
    case 'stale_ceiling':
    case 'ci_pass_floor':
      return [];
  }
}

/** Aggregate agreements are judged against a metric, not a PR list. */
export function aggregateBreached(agreement: Agreement, metricValue: number | null): boolean | null {
  if (metricValue === null) return null; // unknown, never "fine" — same rule as the plans verifier
  const def = AGREEMENT_DEFAULTS[agreement.kind];
  const limit = thresholdNumber(agreement, def.key, def.value);
  if (agreement.kind === 'stale_ceiling') return metricValue > limit;
  if (agreement.kind === 'ci_pass_floor') return metricValue < limit;
  return null;
}

/** The catalog entry an agreement breach maps onto (IMPROVEMENT_PLANS.md §1). */
export const AGREEMENT_CATALOG_ID: Record<AgreementKind, string> = {
  pr_size_max: 'oversized-prs',
  review_within_hours: 'first-review-slow',
  no_unreviewed_merge: 'unreviewed-merges',
  stale_ceiling: 'stale-queue',
  ci_pass_floor: 'flaky-workflow',
};
