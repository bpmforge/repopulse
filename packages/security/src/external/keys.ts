// Scanner keys for findings RepoPulse did not produce (W18-24).
//
// Every external finding is stored under `external:<tool>` (a SARIF upload) or
// `external:<tool>:code-scanning` (pulled from GitHub). The key is load-bearing
// in three places, which is why it has a single builder and a single parser:
//
//   the STALE SWEEP is scoped by scanner key, so an upload from eslint can only
//   ever close eslint's findings — never ours, never semgrep's;
//   the DEDUP KEY includes it, so CodeQL and our own rule flagging the same
//   line stay two findings until the dedup map says one yields;
//   the UI reads it to say whose opinion a finding is.
//
// The upload and the pull are DIFFERENT keys on purpose. A team that uploads
// CodeQL SARIF to us and also has GitHub's code scanning on would otherwise
// have one sweep closing the other's findings every time the two disagreed
// about which alerts are open.

export const EXTERNAL_KEY_PREFIX = 'external:';

export type ExternalSource = 'sarif' | 'code_scanning';

const SOURCE_SUFFIX: Record<ExternalSource, string> = {
  sarif: '',
  code_scanning: ':code-scanning',
};

/**
 * A tool name as a key segment: lowercase, `[a-z0-9._-]`, at most 40 chars.
 *
 * "CodeQL", "codeql" and "CodeQL " are one tool. Anything else collapses to a
 * hyphen rather than being rejected — a tool called "Snyk Code" is still a
 * tool, and refusing its upload over a space would be pedantry.
 */
export function toolSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug === '' ? 'unknown-tool' : slug;
}

export function externalScannerKey(tool: string, source: ExternalSource): string {
  return `${EXTERNAL_KEY_PREFIX}${toolSlug(tool)}${SOURCE_SUFFIX[source]}`;
}

export function isExternalScannerKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(EXTERNAL_KEY_PREFIX);
}

/** `{tool, source}` from a stored key; null for our own scanners. */
export function parseExternalScannerKey(
  key: string | null | undefined,
): { tool: string; source: ExternalSource } | null {
  if (!isExternalScannerKey(key)) return null;
  const rest = (key as string).slice(EXTERNAL_KEY_PREFIX.length);
  if (rest.endsWith(SOURCE_SUFFIX.code_scanning)) {
    return { tool: rest.slice(0, -SOURCE_SUFFIX.code_scanning.length), source: 'code_scanning' };
  }
  return { tool: rest, source: 'sarif' };
}

/** The rule id an external finding is stored under: `external.<tool>.<rule>`. */
export function externalRuleId(tool: string, nativeRule: string): string {
  // Namespaced like the in-sandbox adapters' `tool.ruff.E722`, so the
  // false-positive rate the pricer reads accrues to the tool's rule and never
  // to one of ours that happens to share an id.
  return `external.${toolSlug(tool)}.${nativeRule}`;
}
