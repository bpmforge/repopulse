import type { SecretMatch } from './detect.js';

// Verified-secret escalation (W8-04, SECURITY_SUITE.md 3.1).
//
// The design's rule: a detector that CONFIRMS a credential is live escalates to
// severity 5 / confidence 5 and surfaces immediately (org banner, top of the
// Security tab). Everything else stays at the rule's own severity and reads as
// unverified.
//
// What ships here is the OFFLINE half, and it is deliberately weaker than the
// word "verified" suggests:
//
//   - a FORMAT verifier says "this is shaped like a real ghp_ token". It raises
//     confidence and NEVER sets verified, because shape is not liveness: a
//     revoked token and a live one are the same string.
//   - a LIVE verifier would say "this credential authenticates right now". That
//     needs an outbound request to the issuer with someone else's credential,
//     which is config-gated and default OFF - and is NOT implemented in this
//     wave. Enabling the flag throws rather than quietly returning unverified,
//     because a switch that reads as on and does nothing is worse than no
//     switch at all.

export type VerificationOutcome = 'verified' | 'format_ok' | 'unverified';

export interface VerificationResult {
  outcome: VerificationOutcome;
  /** Why, in a sentence, for the finding's evidence line. */
  reason: string;
}

export interface SecretsVerificationConfig {
  /** Live issuer probes. Default OFF (SECURITY_SUITE 3.1). */
  liveVerification?: boolean;
}

export class LiveVerificationUnavailableError extends Error {
  constructor() {
    super(
      'live secret verification is enabled but not implemented — see docs/STATUS.md (W8-04). ' +
        'Set liveVerification off rather than shipping a switch that does nothing.',
    );
    this.name = 'LiveVerificationUnavailableError';
  }
}

/** Format verifiers by rule id. Absent = nothing offline can be said. */
const FORMAT_VERIFIERS: Record<string, (secret: string) => boolean> = {
  // ghp_/gho_/ghu_/ghs_/ghr_ + exactly 36 base62 characters. GitHub also
  // embeds a checksum in the tail, which is NOT checked here: this codebase
  // has no real token to verify that claim against, and an unverified checksum
  // implementation would reject valid tokens while claiming rigour.
  'github-pat': (s) => /^gh[pousr]_[A-Za-z0-9]{36}$/.test(s),
  'aws-access-key-id': (s) => /^(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}$/.test(s),
  'stripe-secret-key': (s) => /^sk_(?:live|test)_[A-Za-z0-9]{24,99}$/.test(s),
  'private-key-block': () => true,
};

export function verifyMatch(
  match: SecretMatch,
  config: SecretsVerificationConfig = {},
): VerificationResult {
  if (config.liveVerification) throw new LiveVerificationUnavailableError();

  const verifier = FORMAT_VERIFIERS[match.ruleId];
  if (verifier?.(match.secret)) {
    return {
      outcome: 'format_ok',
      reason: 'matches the issuer’s documented token format; liveness not checked',
    };
  }
  return { outcome: 'unverified', reason: 'pattern match, not verified against the issuer' };
}

export interface Escalation {
  severity: number;
  confidence: number;
  /** True only for a CONFIRMED live credential — drives the org banner. */
  surfaceImmediately: boolean;
}

/**
 * Severity and confidence for one match.
 *
 * Only `verified` escalates. A format match moves confidence to 4 and leaves
 * severity where the rule put it: if a shape check could raise severity to 5,
 * every `AKIA...` in a test fixture would page someone.
 */
export function escalate(match: SecretMatch, verification: VerificationResult): Escalation {
  if (verification.outcome === 'verified') {
    return { severity: 5, confidence: 5, surfaceImmediately: true };
  }
  if (verification.outcome === 'format_ok') {
    return { severity: match.severity, confidence: 4, surfaceImmediately: false };
  }
  return { severity: match.severity, confidence: 3, surfaceImmediately: false };
}
