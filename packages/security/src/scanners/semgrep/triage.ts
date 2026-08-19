import type { FindingStatus } from '@repopulse/insights';

// Triage mapping (W8-07, SECURITY_SUITE.md §3.3 / §1.3, FR-INSIGHTS-1).
//
// The semgrep-runner discipline from bpm-opencode-experts, put onto this
// product's lifecycle rails: a reviewer judges a static match REAL, FP or
// leaves it UNVERIFIED, and each verdict means something different to the
// store.
//
// UNVERIFIED IS NOT A WEAKER FINDING, it is an unjudged one — which is why it
// maps to `open` rather than to a lower severity or a hidden state. A queue
// that hides what nobody has looked at is a queue that reports itself finished.

export type Verdict = 'REAL' | 'FP' | 'UNVERIFIED';

export interface TriageOutcome {
  status: FindingStatus;
  /** Only a false-positive dismissal feeds the tuning metric. */
  dismissReason: 'false_positive' | null;
  /** Written to finding_events, so "why did this move" is answerable. */
  reason: string;
}

export function triageOutcome(verdict: Verdict): TriageOutcome {
  switch (verdict) {
    case 'REAL':
      return {
        status: 'confirmed',
        dismissReason: null,
        reason: 'reviewer confirmed the static match is real',
      };
    case 'FP':
      // false_positive specifically, not a generic dismissal: the
      // false-positive RATE is what tells us whether a rule is worth keeping,
      // and 'not applicable' or 'accepted risk' are decisions about this
      // codebase rather than about the rule.
      return {
        status: 'dismissed',
        dismissReason: 'false_positive',
        reason: 'reviewer judged the static match a false positive',
      };
    default:
      return { status: 'open', dismissReason: null, reason: 'not yet reviewed' };
  }
}
