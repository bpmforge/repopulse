// Finding lifecycle (W6-03, FR-INSIGHTS-1, ANALYSIS_TIERS.md §5).
//
// Two rules shape the table below, and both exist because a finding is a claim
// about someone's code:
//
//   A human decision is never undone by a machine. `dismissed` and `wont_fix`
//   are judgements; the re-review pass may not quietly reopen them because the
//   model said the same thing again.
//
//   A resolved finding whose evidence REAPPEARS does reopen — with an audit
//   row. That is not undoing a judgement, it is new information: the code came
//   back.

export type FindingStatus = 'open' | 'confirmed' | 'dismissed' | 'resolved' | 'wont_fix';

export type DismissReason =
  'false_positive' | 'accepted_risk' | 'not_applicable' | 'duplicate' | 'outdated_diff';

/** Transitions a person may make (FR-INSIGHTS-1). */
const HUMAN: Record<FindingStatus, FindingStatus[]> = {
  // open → resolved (W20-08, UX_TODO FND-58): a person who fixed the code had
  // to Confirm first and then Mark fixed, writing two notes for one fix.
  open: ['confirmed', 'resolved', 'dismissed', 'wont_fix'],
  confirmed: ['resolved', 'dismissed', 'wont_fix'],
  dismissed: ['open'],
  wont_fix: ['open'],
  // Resolved is an end state for a person; if the code regresses, the automatic
  // reopen below is what brings it back — with the evidence to justify it.
  resolved: ['open'],
};

export function canTransition(from: FindingStatus, to: FindingStatus): boolean {
  return (HUMAN[from] ?? []).includes(to);
}

export interface AutoDecision {
  next: FindingStatus;
  reason: string;
}

/**
 * What the re-review pass does with a finding whose file left the diff.
 *
 * `outdated_diff` rather than `resolved`: we did not observe the problem being
 * fixed, we observed that we stopped looking at the file. Recording it as
 * resolved would credit a fix that may not have happened, and would make the
 * resolution rate a number nobody should trust.
 */
export function autoResolveOutdated(current: FindingStatus): AutoDecision | null {
  if (current === 'dismissed' || current === 'wont_fix' || current === 'resolved') return null;
  return {
    next: 'resolved',
    reason: 'outdated_diff',
  };
}

/**
 * What happens when a dedup key reappears on a later run.
 *
 * A dismissed or wont_fix finding stays where a person put it: the model
 * repeating itself is not new information about a judgement already made.
 */
export function reappearanceDecision(current: FindingStatus): AutoDecision | null {
  if (current === 'resolved') {
    return { next: 'open', reason: 'evidence reappeared after resolution' };
  }
  return null;
}

/**
 * FP-suppression memory (W6-05, R-B4).
 *
 * A finding dismissed as a false positive must NEVER come back while its
 * evidence is unchanged — the dedup key IS the "unchanged" test. Re-surfacing
 * it would mean a person's judgement is overruled by the next scheduled run,
 * and a dismiss button that does not stick is a dismiss button nobody presses
 * twice.
 *
 * The occurrence count still bumps: how often a suppressed pattern recurs is
 * useful, and silently discarding the sighting would lose it.
 */
export function isSuppressed(status: FindingStatus, reason: string | null): boolean {
  return status === 'dismissed' && reason === 'false_positive';
}

/**
 * W20-21 (UX_TODO FND-61): a leaked secret a person recorded as rotated. It is
 * resolved with reason `rotated`; the old commit still holds the secret, so a
 * later history sweep sees it again, and that sighting is not news: the
 * credential it names no longer works.
 */
export function staysClosed(status: FindingStatus, reason: string | null): boolean {
  return status === 'resolved' && reason === 'rotated';
}

/** false_positive dismissals feed analysis_false_positive_rate (FR-INSIGHTS-1). */
export function countsAsFalsePositive(status: FindingStatus, reason: string | null): boolean {
  return status === 'dismissed' && reason === 'false_positive';
}
