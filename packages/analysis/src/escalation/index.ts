// Tier-2 → Tier-3 escalation (W7-01, ANALYSIS_TIERS.md §6).
//
// Escalation decides when a finding is worth sending a customer's code to a
// third party. The rule that matters most is the one that does NOT escalate:
// without a per-repo opt-in the PR gets a "needs T3" badge and nothing leaves
// the network. Silent egress — sending code because a heuristic thought it was
// important — is the single worst thing this subsystem could do.

export interface EscalationCandidate {
  dimension: string;
  severity: number;
  confidence: number;
}

export interface EscalationContext {
  /** Per-repo admin flag (FR-ANALYSIS-1). */
  t3OptIn: boolean;
  /** Repo marked business-critical by an admin. */
  repoCritical?: boolean;
  /** Workspace monthly budget in USD, and what has been spent so far. */
  budgetUsd?: number | null;
  spentUsd?: number;
}

export type EscalationOutcome =
  | { action: 'escalate'; reason: string }
  | { action: 'needs_opt_in'; reason: string }
  | { action: 'queued_budget'; reason: string }
  | { action: 'none'; reason: string };

/** Does this finding meet a §6 escalation trigger, ignoring permission? */
export function meetsTrigger(candidate: EscalationCandidate, repoCritical = false): string | null {
  // High severity that the local model was UNSURE about — exactly the case a
  // stronger model earns its cost on. High severity with high confidence does
  // not need a second opinion; it needs fixing.
  if (candidate.severity >= 4 && candidate.confidence <= 3) {
    return 'severity ≥ 4 with low confidence';
  }
  if (candidate.dimension === 'security' && candidate.severity >= 3) {
    return 'security finding at severity ≥ 3';
  }
  if (repoCritical) return 'repository is marked critical';
  return null;
}

/**
 * The full decision, permission and budget included.
 *
 * Order is deliberate: trigger, then opt-in, then budget. Checking budget first
 * would report "over budget" for a repository that was never allowed to
 * escalate in the first place, which sends someone to raise a limit that would
 * change nothing.
 */
export function decideEscalation(
  candidate: EscalationCandidate,
  ctx: EscalationContext,
): EscalationOutcome {
  const trigger = meetsTrigger(candidate, ctx.repoCritical);
  if (!trigger) return { action: 'none', reason: 'no escalation trigger met' };

  if (!ctx.t3OptIn) {
    // The badge, never the call. A heuristic deciding on its own that code
    // should leave the network is the failure this whole path is designed
    // around.
    return {
      action: 'needs_opt_in',
      reason: `${trigger}, but this repository has not opted in to Tier-3 — flagged, not sent`,
    };
  }

  if (ctx.budgetUsd !== null && ctx.budgetUsd !== undefined) {
    const spent = ctx.spentUsd ?? 0;
    if (spent >= ctx.budgetUsd) {
      // QUEUED, not dropped: the work is still wanted, it just cannot be paid
      // for this month. Dropping it silently would make a budget look like a
      // quality change.
      return {
        action: 'queued_budget',
        reason: `${trigger}, but the monthly Tier-3 budget ($${ctx.budgetUsd}) is spent — queued`,
      };
    }
  }

  return { action: 'escalate', reason: trigger };
}
