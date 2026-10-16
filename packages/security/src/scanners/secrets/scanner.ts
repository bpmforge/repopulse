import { fingerprintSecret, redactSecretFinding, type IncomingFinding } from '@repopulse/insights';
import { scanDiff, type DiffPatchInput, type SecretMatch } from './detect.js';
import { loadRulepack, type Rulepack } from './rulepack.js';
import { escalate, verifyMatch, type SecretsVerificationConfig } from './verify.js';

// The secrets scanner (W8-04, SECURITY_SUITE.md 3.1, FR-SEC-3 / SC-29).
//
// Stream mode: it runs over diff patches as they are ingested — no snapshot, no
// container, no forge tarball. That is why it is the one scanner that can meet
// "a finding within 60s of the webhook".

export const SECRETS_SCANNER_KEY = 'secrets';

export interface SecretFindingRow extends IncomingFinding {
  /** sha256 of the credential — the ONLY representation that is ever stored. */
  fingerprint: string;
  /** True only for a live-verified credential: drives the org banner. */
  surfaceImmediately: boolean;
}

export interface BuildFindingsArgs {
  files: readonly DiffPatchInput[];
  rulepack?: Rulepack;
  verification?: SecretsVerificationConfig;
}

/**
 * Diff patches in, storable findings out.
 *
 * The plaintext credential exists only inside this function. What leaves is a
 * fingerprint plus a location (SC-29) — assertRedacted in the insights package
 * throws if a caller ever manages to build one that still contains the value.
 */
export function buildSecretFindings(args: BuildFindingsArgs): SecretFindingRow[] {
  const pack = args.rulepack ?? loadRulepack();
  const matches = scanDiff(args.files, { rulepack: pack });
  return matches.map((match) => toFinding(match, pack, args.verification));
}

function toFinding(
  match: SecretMatch,
  pack: Rulepack,
  verification?: SecretsVerificationConfig,
): SecretFindingRow {
  const result = verifyMatch(match, verification ?? {});
  const level = escalate(match, result);
  const rule = pack.rules.find((r) => r.id === match.ruleId);
  const redacted = redactSecretFinding({
    file: match.file,
    lineStart: match.line,
    lineEnd: match.line,
    ruleId: match.ruleId,
    secret: match.secret,
  });

  return {
    dimension: 'secrets',
    severity: level.severity,
    confidence: level.confidence,
    file: redacted.file,
    lineStart: redacted.lineStart,
    lineEnd: redacted.lineEnd,
    title: `${titleFor(match.kind, rule?.description)} committed in ${match.file}`,
    // The rulepack version is on the evidence line as well as the scan_run:
    // a finding is only reproducible against the pack that produced it, and
    // the evidence is what a person reads when they ask why this fired.
    evidenceQuote: `${redacted.evidence} · ${pack.versionTag} · ${result.reason}`,
    rationale:
      'A credential in version control is readable by everyone with repository access, ' +
      'and stays readable in history after it is deleted.',
    suggestedFix: 'Rotate the credential at the issuer, then remove it from the file.',
    scannerKey: SECRETS_SCANNER_KEY,
    ruleId: match.ruleId,
    // Chaining input (SECURITY_SUITE 3.1): the attack chainer matches this
    // against another finding's preconditions.
    yields: { [`credential:${match.kind}`]: true },
    fingerprint: redacted.fingerprint,
    surfaceImmediately: level.surfaceImmediately,
    ...(rule?.candidate ? { experimental: true } : {}),
  };
}

function titleFor(kind: string, description?: string): string {
  const named: Record<string, string> = {
    aws: 'AWS credential',
    github: 'GitHub token',
    gitlab: 'GitLab token',
    gitea: 'Gitea token',
    slack: 'Slack token',
    stripe: 'Stripe secret key',
    anthropic: 'Anthropic API key',
    openai: 'OpenAI API key',
    google: 'Google API key',
    npm: 'npm token',
    private_key: 'Private key',
    jwt: 'JSON Web Token',
    generic: 'Secret',
  };
  return named[kind] ?? description ?? 'Secret';
}

/** Exported for the chainer and for tests that assert nothing else leaks. */
export { fingerprintSecret };
