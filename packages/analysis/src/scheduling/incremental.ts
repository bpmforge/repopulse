import { normalizeForMatch } from '../schema/finding.js';
import { SPECIALISTS } from '../specialists/registry.js';

// Incremental re-review of a pull request on a new push (W23-07,
// INCREMENTAL_SCAN_PLAN §10 X8, §11 WP-X8).
//
// A review answers one question per (PR, specialist/dimension, head). When the
// PR gets another push, most files did not change, and neither did the model's
// answer about them: only the hunks changed since the head that was last
// reviewed need the model again. Everything here is PURE - the forge compare
// happens in the api worker (analysis never calls the forge, module boundary)
// and its file list is handed in; the findings move in packages/insights.
//
// FULL whenever there is any doubt: no earlier review, one that did not finish
// cleanly, a different prompt version, a compare that is unavailable or
// truncated (its list may be SHORT, so "only these changed" would be a guess),
// or `force`. An incremental review that quietly missed a file is worse than
// the full review it saved.

/** The stamp stored on a review: the checklist version of every specialist, in a fixed order. */
export function reviewPromptVersion(
  specialists: readonly { id: string; checklistVersion: string }[] = SPECIALISTS,
): string {
  return [...specialists]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => `${s.id}@${s.checklistVersion}`)
    .join('+');
}

export interface PriorReview {
  runId: number;
  /** The head commit that review read. */
  headSha: string;
  promptVersion: string | null;
  /** It finished and every specialist that should have run answered (no drops, no failures). */
  completeAndClean: boolean;
}

export interface ReviewComparison {
  files: readonly { path: string; status: string; previousPath?: string }[];
  truncated: boolean;
}

export type ReviewScopeReason =
  | 'forced'
  | 'no_prior_review'
  | 'prior_not_clean'
  | 'same_head'
  | 'prompt_version_changed'
  | 'compare_unavailable'
  | 'compare_truncated'
  | 'no_reviewable_change'
  | 'incremental';

export type ReviewScopePlan =
  | { scope: 'full'; reason: Exclude<ReviewScopeReason, 'incremental'> }
  | {
      scope: 'incremental';
      reason: 'incremental';
      baseRunId: number;
      /** Head the earlier review read; the UI's "incremental since <sha7>". */
      sinceSha: string;
      /** Files of the PR diff that changed between the two heads. */
      changed: string[];
    };

export interface PlanReviewScopeArgs {
  prior: PriorReview | null;
  newHeadSha: string;
  promptVersion: string;
  force?: boolean;
  /** null = no compare was possible (forge cannot, or it threw). */
  comparison: ReviewComparison | null;
  /** Paths of the PR's own current diff; only these can be reviewed. */
  prFiles: readonly string[];
}

/**
 * Whether to review the whole PR diff or only what changed since the prior
 * reviewed head. `comparison` is fetched by the caller only when the cheaper
 * checks pass (see `needsCompare`), so a full review costs no forge call.
 */
export function planReviewScope(a: PlanReviewScopeArgs): ReviewScopePlan {
  const early = needsCompare(a);
  if (early !== 'compare') return { scope: 'full', reason: early };
  const prior = a.prior!;
  if (a.comparison === null) return { scope: 'full', reason: 'compare_unavailable' };
  if (a.comparison.truncated) return { scope: 'full', reason: 'compare_truncated' };
  const touched = new Set<string>();
  for (const f of a.comparison.files) if (f.status !== 'removed') touched.add(f.path);
  const changed = a.prFiles.filter((p) => touched.has(p));
  if (changed.length === 0) return { scope: 'full', reason: 'no_reviewable_change' };
  return {
    scope: 'incremental',
    reason: 'incremental',
    baseRunId: prior.runId,
    sinceSha: prior.headSha,
    changed,
  };
}

/** The checks that need no forge call; 'compare' = go and ask the forge. */
export function needsCompare(
  a: Pick<PlanReviewScopeArgs, 'prior' | 'newHeadSha' | 'promptVersion' | 'force'>,
): 'compare' | Exclude<ReviewScopeReason, 'incremental' | 'compare_unavailable' | 'compare_truncated' | 'no_reviewable_change'> {
  if (a.force) return 'forced';
  if (!a.prior) return 'no_prior_review';
  if (!a.prior.completeAndClean) return 'prior_not_clean';
  if (a.prior.headSha === a.newHeadSha) return 'same_head';
  if (a.prior.promptVersion !== a.promptVersion) return 'prompt_version_changed';
  return 'compare';
}

/** Keeps the diff entries of the changed files: the only hunks that go to the model. */
export function restrictDiff<T extends { path: string }>(
  files: readonly T[],
  changed: readonly string[],
): T[] {
  const set = new Set(changed);
  return files.filter((f) => set.has(f.path));
}

/**
 * The text of a patch's NEW side: context and added lines, markers removed.
 * Removed lines are not in the new code, so a quote that only they contain has
 * vanished.
 */
export function newSideText(patch: string): string {
  const out: string[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+') || line.startsWith(' ')) out.push(line.slice(1));
    else if (line === '') out.push('');
  }
  return out.join('\n');
}

/**
 * Whether a finding's quote is still in the file's new diff, by the same
 * normalisation the evidence validator uses (whitespace collapsed, lower case).
 */
export function quoteStillPresent(quote: string, patch: string | undefined): boolean {
  if (patch === undefined) return false;
  const needle = normalizeForMatch(quote);
  if (needle === '') return false;
  return normalizeForMatch(newSideText(patch)).includes(needle);
}
