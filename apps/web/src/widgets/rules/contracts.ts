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

/** What the next step is, in words, for each state. */
export const RULE_NEXT_STEP: Record<RuleLifecycleStatus, string> = {
  proposed: 'Accept to shadow',
  candidate: 'Promote to active',
  active: 'Deprecate',
  deprecated: 'Return to shadow',
};

export const RULE_NEXT_STATUS: Record<RuleLifecycleStatus, RuleLifecycleStatus> = {
  proposed: 'candidate',
  candidate: 'active',
  active: 'deprecated',
  deprecated: 'candidate',
};
