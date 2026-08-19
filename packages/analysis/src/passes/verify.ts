import type { T2Host } from '../t2/client.js';

// Verify pass (W6-05, FR-ANALYSIS-9/10).
//
// The entire value of this pass rests on one rule: the model that judges a
// finding must not be the model that raised it. A model asked "was I right?"
// agrees with itself, so a same-host verify pass would produce a confirmation
// rate near 100% and a "verified by a second model" badge that means nothing —
// worse than no badge, because people would trust it.

export type VerifyStatus = 'unverified' | 'confirmed' | 'contradicted';

/** Findings below this severity are not worth a second model call. */
export const VERIFY_SEVERITY_FLOOR = 3;

/** Severity at or above which a finding must survive a challenge before it is surfaced loudly. */
export const CHALLENGE_SEVERITY_FLOOR = 4;

export interface VerifiableFinding {
  id: number;
  severity: number;
  dimension: string;
  file: string;
  title: string;
  evidenceQuote: string;
  rationale: string;
  /** Host that produced it — the verifier must differ. */
  finderHostUrl: string;
}

export class NoIndependentHostError extends Error {
  constructor() {
    super(
      'No second Tier-2 host is available, so no finding can be independently verified. ' +
        'Refused rather than verifying on the finder host: a model asked whether it was right ' +
        'agrees with itself, and a confirmation produced that way is worse than none.',
    );
    this.name = 'NoIndependentHostError';
  }
}

/**
 * Picks a verifier host that is NOT the finder's.
 *
 * Returns null rather than falling back to the finder. The caller leaves the
 * finding `unverified`, which is an honest state; a self-confirmation is not.
 */
export function pickVerifierHost(hosts: readonly T2Host[], finderHostUrl: string): T2Host | null {
  return hosts.find((h) => h.baseUrl !== finderHostUrl) ?? null;
}

export function needsVerification(severity: number): boolean {
  return severity >= VERIFY_SEVERITY_FLOOR;
}

/**
 * Refute-FIRST framing.
 *
 * The prompt asks the verifier to argue the finding is wrong, and to confirm
 * only if it cannot. Asking "is this correct?" invites agreement — the model
 * has been handed a confident claim and a reason to accept it. Asking it to
 * refute makes agreement the expensive answer.
 */
export function buildVerifyPrompt(finding: VerifiableFinding, diffExcerpt: string): string {
  return [
    'You are reviewing another reviewer, and your default position is that they are WRONG.',
    'Your task is to REFUTE the finding below using only the diff excerpt provided.',
    '',
    'Refute it if ANY of these hold:',
    '- the quoted evidence does not appear in the diff, or does not mean what the finding claims;',
    '- the conclusion depends on code that is not shown;',
    '- the pattern is normal and safe in this context;',
    '- the finding is speculative rather than observed.',
    '',
    'Confirm ONLY if you cannot refute it on the evidence shown.',
    '',
    `Finding: ${finding.title}`,
    `Dimension: ${finding.dimension} · severity ${finding.severity}`,
    `File: ${finding.file}`,
    `Claimed evidence: ${finding.evidenceQuote}`,
    `Reasoning given: ${finding.rationale}`,
    '',
    'Diff excerpt:',
    '```diff',
    diffExcerpt,
    '```',
    '',
    'Respond ONLY with JSON: {"refuted":true|false,"reason":"<=400 chars"}',
  ].join('\n');
}

export interface VerdictInput {
  refuted: boolean;
  reason: string;
}

export function verdictToStatus(verdict: VerdictInput): VerifyStatus {
  return verdict.refuted ? 'contradicted' : 'confirmed';
}

/**
 * Whether a finding may be surfaced loudly (org banner, top of Security tab).
 *
 * FR-ANALYSIS-10: severity ≥ 4 must SURVIVE a challenge first. An unverified
 * severity-5 claim on an org banner is the most expensive way for this product
 * to be wrong — everyone sees it, and being wrong once there costs more trust
 * than ten correct findings earn.
 */
export function mayBeSurfacedLoudly(finding: {
  severity: number;
  verifyStatus: VerifyStatus;
}): boolean {
  if (finding.verifyStatus === 'contradicted') return false;
  if (finding.severity >= CHALLENGE_SEVERITY_FLOOR) return finding.verifyStatus === 'confirmed';
  return true;
}

/** One verify call per finding, hard cap (FR-ANALYSIS-9 / loop discipline §B2). */
export function planVerifyCalls(
  findings: readonly VerifiableFinding[],
  hosts: readonly T2Host[],
): { finding: VerifiableFinding; host: T2Host }[] {
  const plan: { finding: VerifiableFinding; host: T2Host }[] = [];
  for (const finding of findings) {
    if (!needsVerification(finding.severity)) continue;
    const host = pickVerifierHost(hosts, finding.finderHostUrl);
    // No independent host: skipped, NOT verified on the finder. The finding
    // stays `unverified`, which is exactly what it is.
    if (!host) continue;
    plan.push({ finding, host });
  }
  return plan;
}
