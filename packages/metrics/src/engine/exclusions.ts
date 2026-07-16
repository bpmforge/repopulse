import { isBotLogin } from './bots.js';

// METRICS.md §0: merge commits (>1 parent) double-count the branch's changes
// into churn/ownership/hotspots - excluded from those, but still count for
// DORA lead-time linkage (a separate, non-churn code path).
export function isMergeCommit(parentShaCount: number): boolean {
  return parentShaCount > 1;
}

export interface ChurnEligibility {
  authorLogin: string;
  parentShaCount: number;
  /**
   * Set by the reconciliation sweep (W2-05) when a force-push/rebase
   * orphans this commit row. NOTE: `commits.superseded` does not exist yet
   * in packages/shared's schema (W1-02) - this field is accepted here as a
   * plain boolean so the exclusion rule is unit-testable and ready for
   * whichever ticket adds the column; flagged, not silently worked around.
   */
  superseded: boolean;
}

/** METRICS.md §0: bot, merge-commit, and superseded exclusions, combined. */
export function isEligibleForChurn(
  commit: ChurnEligibility,
  botGlobs?: readonly string[],
): boolean {
  if (isBotLogin(commit.authorLogin, botGlobs)) return false;
  if (isMergeCommit(commit.parentShaCount)) return false;
  if (commit.superseded) return false;
  return true;
}
