import type { IncomingFinding } from '@repopulse/insights';
import { externalRuleId, externalScannerKey, toolSlug, type ExternalSource } from './keys.js';

// One external result, whatever it arrived as (W18-24).
//
// A SARIF result and a GitHub code-scanning alert are normalised to this shape
// first, so severity, dimension and the stored finding are decided ONCE. Two
// mappers would drift, and the drift would show up as the same CodeQL query
// pricing differently depending on whether a team uploaded its SARIF or let us
// pull the alert.

export interface ExternalResult {
  tool: string;
  toolVersion: string | null;
  /** The tool's own rule id, unprefixed: `js/sql-injection`, `no-empty`. */
  ruleId: string;
  /** Human rule name or short description, when the tool gave one. */
  ruleTitle: string | null;
  /** SARIF level: 'error' | 'warning' | 'note' | 'none'. Null = unstated. */
  level: string | null;
  /** CVSS-like 0.0-10.0 (`security-severity`), when the tool gave one. */
  securitySeverity: number | null;
  /** CodeQL-style precision: 'very-high' | 'high' | 'medium' | 'low'. */
  precision: string | null;
  tags: string[];
  file: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  message: string;
  /** The tool's stable identity for this result, for the dedup key. */
  fingerprint: string | null;
}

/** Stored text never exceeds this; a SARIF message can be a page of markdown. */
export const MAX_MESSAGE_CHARS = 2000;
const MAX_TITLE_CHARS = 200;

// Kept deliberately SMALL. A tool not listed falls through to the tag and
// severity signals, which are what actually say whether a result is about
// security; this list only covers tools whose every result is one kind of
// thing whatever its tags say.
const SECRETS_TOOLS = new Set(['gitleaks', 'trufflehog', 'detect-secrets', 'ggshield']);
const IAC_TOOLS = new Set(['checkov', 'tfsec', 'kics', 'terrascan', 'trivy', 'hadolint']);
const SAST_TOOLS = new Set(['bandit', 'gosec', 'brakeman', 'njsscan', 'flawfinder', 'horusec']);
const DEPENDENCY_RULE = /^(CVE-\d{4}-\d+|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i;

/**
 * Which existing dimension an external result belongs in.
 *
 * Only values from FINDING_DIMENSIONS — inventing an `external` dimension
 * would put a CodeQL injection finding in a different facet, score and report
 * section from the identical finding our own pack makes, and the point of
 * ingesting is to have ONE place for all of them.
 *
 * Order matters: a CVE id is a dependency finding whichever tool reported it
 * (trivy and grype both emit SARIF), and a secrets tool's finding is a secret
 * even when it carries no security tag.
 */
export function dimensionFor(r: ExternalResult): string {
  const tool = toolSlug(r.tool);
  const tags = r.tags.map((t) => t.toLowerCase());
  if (DEPENDENCY_RULE.test(r.ruleId)) return 'dependency';
  if (SECRETS_TOOLS.has(tool) || tags.includes('secret') || tags.includes('secrets')) {
    return 'secrets';
  }
  if (IAC_TOOLS.has(tool)) return 'iac';
  const securityish =
    SAST_TOOLS.has(tool) ||
    r.securitySeverity !== null ||
    tags.includes('security') ||
    tags.some((t) => /(^|\/)cwe[-/]?\d+/.test(t));
  if (securityish) return 'sast';
  if (tags.includes('performance')) return 'performance';
  return 'code_health';
}

/**
 * 1-5 on our canonical scale (5 critical … 1 info).
 *
 * `security-severity` wins when present: it is the tool's own CVSS-style
 * score, and the bands are the ones GitHub publishes for it (≥9 critical,
 * ≥7 high, ≥4 medium, >0 low). Otherwise the SARIF level — whose absence
 * means `warning` by the SARIF spec (§3.27.10), not "unknown".
 */
export function severityFor(r: Pick<ExternalResult, 'securitySeverity' | 'level'>): number {
  const s = r.securitySeverity;
  if (s !== null && Number.isFinite(s)) {
    if (s >= 9) return 5;
    if (s >= 7) return 4;
    if (s >= 4) return 3;
    if (s > 0) return 2;
    return 1;
  }
  switch ((r.level ?? 'warning').toLowerCase()) {
    case 'error':
      return 4;
    case 'note':
      return 2;
    case 'none':
      return 1;
    default:
      return 3;
  }
}

/**
 * 1-5. Three by default — the confidence our own pattern-matching SAST rules
 * carry — because an untriaged match from someone else's engine is no more
 * certain than one from ours. CodeQL's published precision moves it.
 */
export function confidenceFor(r: Pick<ExternalResult, 'precision'>): number {
  switch (r.precision?.toLowerCase()) {
    case 'very-high':
    case 'high':
      return 4;
    case 'low':
      return 2;
    default:
      return 3;
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Turns one normalised result into a storable finding. */
export function toIncomingFinding(r: ExternalResult, source: ExternalSource): IncomingFinding {
  const dimension = dimensionFor(r);
  const tool = toolSlug(r.tool);
  const where = r.file ? `${r.file}${r.lineStart ? `:${r.lineStart}` : ''}` : 'repository';
  // A secrets tool's message may quote the value it found (SC-29: a stored
  // credential is a credential leaked into five more places). Our own secrets
  // scanner fingerprints and discards it; we cannot do that for someone else's
  // output, so the message is not stored at all.
  const rationale =
    dimension === 'secrets'
      ? `${r.tool} reported ${r.ruleId} at ${where}. The tool's message is not stored: secrets-tool output can contain the secret itself.`
      : clip(r.message, MAX_MESSAGE_CHARS);
  const title = clip(r.ruleTitle ?? r.ruleId, MAX_TITLE_CHARS);

  return {
    dimension,
    severity: severityFor(r),
    confidence: confidenceFor(r),
    file: r.file,
    lineStart: r.lineStart,
    lineEnd: r.lineEnd ?? r.lineStart,
    title: `${title} (${r.tool})`.slice(0, MAX_TITLE_CHARS + 50),
    // The same `<where> — <rule>` evidence our own scanners write, so a reader
    // sees one format whichever engine raised the finding.
    evidenceQuote: `${where} — ${tool}/${r.ruleId}`,
    rationale,
    suggestedFix: null,
    scannerKey: externalScannerKey(r.tool, source),
    ruleId: externalRuleId(r.tool, r.ruleId),
    cveId:
      DEPENDENCY_RULE.test(r.ruleId) && /^CVE-/i.test(r.ruleId) ? r.ruleId.toUpperCase() : null,
    // No yields: what an attacker gains is OUR chainer's judgement, made from
    // our rules' metadata. Guessing it from someone else's tag would put
    // chains in front of people that nothing we wrote can explain.
    yields: null,
    fingerprint: r.fingerprint,
  };
}
