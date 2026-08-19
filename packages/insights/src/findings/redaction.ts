import { createHash } from 'node:crypto';

// Secret redaction invariant (W8-02, SC-29).
//
// A secrets finding must never store the secret. The reason is unusually
// concrete: findings are read by the API, rendered in the browser, embedded in
// PDF reports and included in database dumps — so a stored plaintext credential
// is a credential leaked into five more places by the tool that found it.
//
// What is stored instead is enough to act on: WHERE it is, WHAT kind it is, and
// a fingerprint that lets the same secret be recognised across runs without
// ever reproducing it.

export interface SecretMatch {
  file: string;
  lineStart: number;
  lineEnd: number;
  /** Rule that matched, e.g. 'aws-access-key-id'. */
  ruleId: string;
  /** The matched text. Used to fingerprint, then discarded. */
  secret: string;
}

export interface RedactedSecretFinding {
  file: string;
  lineStart: number;
  lineEnd: number;
  ruleId: string;
  /** sha256 of the secret — stable across runs, useless to an attacker. */
  fingerprint: string;
  /** Safe to display: kind, location and length. Never the value. */
  evidence: string;
}

/** sha256 of the raw secret. Full length: a truncated hash invites collisions. */
export function fingerprintSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Turns a raw match into a storable finding.
 *
 * The secret is used once, to fingerprint, and never travels into the returned
 * object. No masking, no first-four-characters: a partial secret is still a
 * secret, and "AKIA…" plus a repo name is often enough to find the rest.
 */
export function redactSecretFinding(match: SecretMatch): RedactedSecretFinding {
  return {
    file: match.file,
    lineStart: match.lineStart,
    lineEnd: match.lineEnd,
    ruleId: match.ruleId,
    fingerprint: fingerprintSecret(match.secret),
    evidence: `${match.ruleId} detected at ${match.file}:${match.lineStart} (${match.secret.length} characters, value not stored)`,
  };
}

/** Guard for the store: refuses to persist anything containing the raw value. */
export function assertRedacted(finding: { evidence: string; title?: string }, secret: string): void {
  const haystack = `${finding.evidence} ${finding.title ?? ''}`;
  if (secret.length >= 8 && haystack.includes(secret)) {
    throw new Error(
      'Refusing to store a secrets finding containing the secret itself (SC-29). ' +
        'Store the fingerprint and location; the value must never reach the database.',
    );
  }
}
