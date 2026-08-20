import type { RuleStatus } from './schema.js';

// Rule lifecycle (W9-07, CODE_HEALTH_SUITE.md §8.2, FR-CH-8).
//
// SHADOW MODE IS THE SAFETY VALVE, and the reason it exists is that a new rule
// is a guess about someone else's codebase. A candidate rule runs on real scans
// and its findings are stamped experimental — visible to anyone who goes
// looking, and excluded from every place a number carries weight: health
// scores, org banners, plan generation, reports.
//
// The alternative, "add it and see", makes the first week of every new rule a
// tax on whoever reads the findings list, and the rule that annoys people in
// its first week is the rule they mute permanently.

export const PROMOTION_GATE = {
  /** Enough findings that the FP rate means something. */
  minFindings: 20,
  /** Enough days that it has seen more than one team's Tuesday. */
  minDays: 30,
  /** Above this, it is not ready — it is noisy. */
  maxFpRate: 0.2,
} as const;

/** Above this, a live rule is auto-flagged for demotion (§8.2). */
export const DEMOTION_FP_RATE = 0.5;

const ALLOWED: Record<RuleStatus, RuleStatus[]> = {
  // Straight to active is deliberately NOT allowed: the gate needs evidence,
  // and evidence needs the rule to have run somewhere first.
  proposed: ['candidate', 'deprecated'],
  candidate: ['active', 'deprecated'],
  active: ['deprecated'],
  // A deprecated rule can come back as a candidate — it must earn its way
  // through shadow again rather than resuming where it left off.
  deprecated: ['candidate'],
};

export function canTransition(from: RuleStatus, to: RuleStatus): boolean {
  return ALLOWED[from].includes(to);
}

export interface RuleEvidence {
  findings: number;
  daysActive: number;
  /** null when nothing has been triaged — NOT 0. */
  fpRate: number | null;
}

export interface PromotionVerdict {
  eligible: boolean;
  /** Every unmet condition, so an admin sees what is missing at once. */
  reasons: string[];
}

export interface PromotionThresholds {
  minFindings?: number;
  minDays?: number;
  maxFpRate?: number;
}

/**
 * Is a candidate ready to go live?
 *
 * Returns the reasons rather than a boolean alone: an admin looking at a
 * greyed-out button needs to know whether to wait a week or fix the rule.
 */
export function promotionVerdict(
  evidence: RuleEvidence,
  thresholds: PromotionThresholds = {},
): PromotionVerdict {
  const gate = { ...PROMOTION_GATE, ...thresholds };
  const reasons: string[] = [];

  if (evidence.findings < gate.minFindings) {
    reasons.push(
      `${evidence.findings} findings, needs ${gate.minFindings} — below that the false-positive rate is noise about noise`,
    );
  }
  if (evidence.daysActive < gate.minDays) {
    reasons.push(`${evidence.daysActive} days in shadow, needs ${gate.minDays}`);
  }
  if (evidence.fpRate === null) {
    // Not eligible, and NOT because the rate is bad — because nobody has
    // triaged anything. Promoting on an untriaged rule would mean the gate
    // measured nothing at all.
    reasons.push('no dispositions yet — nothing has been triaged, so there is no FP rate to judge');
  } else if (evidence.fpRate > gate.maxFpRate) {
    reasons.push(
      `false-positive rate ${(evidence.fpRate * 100).toFixed(0)}%, needs under ${(gate.maxFpRate * 100).toFixed(0)}%`,
    );
  }

  return { eligible: reasons.length === 0, reasons };
}

/** Should a LIVE rule be flagged for demotion? */
export function demotionFlag(evidence: RuleEvidence, threshold = DEMOTION_FP_RATE): boolean {
  // Null is not a flag: an active rule nobody has triaged recently is not
  // thereby a bad rule, and auto-demoting on absence would punish a quiet week.
  return evidence.fpRate !== null && evidence.fpRate > threshold;
}

/**
 * False-positive rate from dispositions.
 *
 * null over an empty set, never 0 — a 0% FP rate across zero triaged findings
 * reads as a flawless rule, and that is exactly the rule nobody has checked.
 */
export function fpRate(dispositions: {
  dismissedFalsePositive: number;
  triaged: number;
}): number | null {
  if (dispositions.triaged === 0) return null;
  return dispositions.dismissedFalsePositive / dispositions.triaged;
}

/**
 * Does a finding from this rule count towards scores, banners, plans, reports?
 *
 * The single predicate every consumer asks, exported once so the answer cannot
 * drift between them. A shadow finding is REAL — it is shown, it is triageable
 * — it simply does not get to move a number.
 */
export function countsTowardsScores(finding: { experimental?: boolean | null }): boolean {
  return finding.experimental !== true;
}

export function isShadow(status: RuleStatus): boolean {
  return status === 'candidate';
}
