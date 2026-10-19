// Rule workbench wire contracts (W9-07). Source: apps/api/src/routes/rules.

export type RuleLifecycleStatus = 'proposed' | 'candidate' | 'active' | 'deprecated';

export interface RuleEvidence {
  findings: number;
  daysActive: number;
  /** null = nothing triaged. NOT 0 — that would read as a flawless rule. */
  fpRate: number | null;
}

export interface RuleRow {
  rule_id: string;
  status: RuleLifecycleStatus;
  provenance: { source?: string; license?: string; author?: string; date?: string };
  shadow_started_at: string | null;
  evidence: RuleEvidence;
  promotion: { eligible: boolean; reasons: string[] };
  demotion_candidate: boolean;
}

export const RULE_STATUS_LABEL: Record<RuleLifecycleStatus, string> = {
  proposed: '· proposed — not running',
  candidate: '◐ shadow — running, excluded from every score',
  active: '✓ active — counts everywhere',
  deprecated: '✕ deprecated — not running',
};

/**
 * Every move an admin may make from each state (W20-03, UX_TODO FND-16).
 *
 * Mirrors ALLOWED in packages/security/src/rules/lifecycle.ts, which the API
 * enforces; the web app does not depend on that package, so the table is
 * repeated and a test pins the two together. The screen used to offer one
 * forward step per state, so a proposed or shadow rule could not be rejected.
 *
 * There is no active → shadow move: CODE_HEALTH_SUITE §8.2 makes demotion an
 * admin-confirmed DEPRECATION, and a deprecated rule earns its way back
 * through shadow (deprecated → candidate) rather than resuming mid-trial.
 */
export const RULE_TRANSITIONS: Record<RuleLifecycleStatus, readonly RuleLifecycleStatus[]> = {
  proposed: ['candidate', 'deprecated'],
  candidate: ['active', 'deprecated'],
  active: ['deprecated'],
  deprecated: ['candidate'],
};

export interface RuleAction {
  label: string;
  /** Asked before the request is sent; null = no confirmation needed. */
  confirm: string | null;
  /** What the status message says once the API agreed. */
  done: string;
  /** Destructive steps are drawn neutral, never as the suggested action. */
  destructive: boolean;
}

/** How each (from → to) move reads on the row. */
export function ruleAction(from: RuleLifecycleStatus, to: RuleLifecycleStatus): RuleAction {
  if (to === 'candidate') {
    return from === 'deprecated'
      ? {
          label: 'Return to shadow',
          confirm: null,
          done: 'Returned to shadow. It runs again, excluded from every score, and its trial starts over.',
          destructive: false,
        }
      : {
          label: 'Accept to shadow',
          confirm: null,
          done: 'Accepted to shadow. It runs on the next scans, excluded from every score.',
          destructive: false,
        };
  }
  if (to === 'active') {
    return {
      label: 'Promote to active',
      confirm:
        'Promote to active? Its findings will count in health scores, reports and plans from the next scan.',
      done: 'Promoted. Its findings count everywhere from the next scan.',
      destructive: false,
    };
  }
  // to === 'deprecated'
  if (from === 'proposed') {
    return {
      label: 'Reject',
      confirm: 'Reject this proposal? It will not run. It can be returned to shadow later.',
      done: 'Rejected. The rule will not run.',
      destructive: true,
    };
  }
  if (from === 'candidate') {
    return {
      label: 'Retire',
      confirm: 'Retire this shadow rule? It stops running. It can be returned to shadow later.',
      done: 'Retired. The rule no longer runs.',
      destructive: true,
    };
  }
  return {
    label: 'Deprecate',
    confirm:
      'Deprecate this active rule? It stops running and its findings stop counting. Bringing it back means a new shadow trial.',
    done: 'Deprecated. The rule no longer runs or counts.',
    destructive: true,
  };
}
