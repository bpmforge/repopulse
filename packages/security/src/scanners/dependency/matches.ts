// Reading grype's JSON (W8-06, SECURITY_SUITE.md §3.2, FR-SEC-5).
//
// Pure, and separated from the container run for the usual reason: the shape
// below was CAPTURED FROM A REAL RUN (fixtures/dependency/jquery-grype.json,
// grype 0.117.0 against the offline database) rather than written from memory,
// and a pure reader lets that capture be the test input.
//
// THE FIELD NAMES HERE ARE THE ONES GRYPE ACTUALLY EMITS, which is not what
// this ticket's brief assumed. Measured against jquery 3.4.1:
//   - known-exploited is `vulnerability.knownExploited`, an ARRAY of objects
//     with a `cve` field. There is no `vulnerability.kev` key at all, and a
//     reader that looked for one reported zero KEV hits on a KEV-carrying
//     package — a silent false negative, which is the exact failure this
//     subsystem exists to avoid.
//   - EPSS is `vulnerability.epss`, also an ARRAY of {cve, epss, percentile},
//     not a scalar.
//   - `vulnerability.id` is frequently a GHSA id, not a CVE. The CVE has to be
//     recovered from relatedVulnerabilities (or from the KEV/EPSS rows, which
//     are keyed by CVE), or every finding would be stored with a null cve_id.

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;

export interface DependencyMatch {
  /** grype's own id — a GHSA more often than not. Stamped as the rule id. */
  vulnerabilityId: string;
  /**
   * EVERY id this match names for one vulnerability — its own, its related
   * ones, and the CVEs the KEV and EPSS rows are keyed by (W8-13 V0).
   *
   * Collected because the collapse below throws the losing record away, and
   * with it the id that record was filed under. grype reports the same
   * vulnerability from two providers as `CVE-2020-14343` (nvd:cpe) and
   * `GHSA-8q59-q68h-6hv4` (github) — captured, not supposed — and a reader who
   * searches for the id in their advisory email must find our finding under it.
   */
  ids: string[];
  /** The CVE, recovered from wherever this match carries one. Null is honest. */
  cveId: string | null;
  /** grype's severity word, kept verbatim for the evidence line. */
  severityLabel: string;
  /** 1-5 on the canonical scale (ANALYSIS_TIERS §4). */
  severity: number;
  /** CISA KEV: this is not a prediction, it is a report of exploitation. */
  kev: boolean;
  /** 0-1 exploit-prediction score, or null when the database has none. */
  epss: number | null;
  purl: string | null;
  packageName: string;
  packageVersion: string;
  /** grype's artifact type: npm, python, java-archive, go-module, ... */
  packageType: string;
  /** Manifest/lockfile paths the component was catalogued from. */
  locations: string[];
  fixVersions: string[];
  /** exact-direct-match, exact-indirect-match, cpe-match, ... */
  matchType: string;
}

export interface MatchFunnel {
  /** Everything grype emitted, before any of our filtering. */
  rawMatches: number;
  /** Collapsed because nvd and github both reported the same (package, CVE). */
  duplicatesCollapsed: number;
  /** Kept, but with no CVE id we could resolve — reported, never dropped. */
  withoutCveId: number;
  /** Kept at severity 3, because grype said `Unknown` and we will not say low. */
  unknownSeverity: number;
}

export interface ParsedMatches {
  matches: DependencyMatch[];
  funnel: MatchFunnel;
  /** From grype's own descriptor, so the stamped version is the one that ran. */
  grypeVersion: string | null;
}

/**
 * grype severity word -> the canonical 1-5 scale.
 *
 * `Unknown` maps to 3, NOT to 1. A vulnerability whose severity nobody has
 * scored yet is an unscored vulnerability, and filing it as "info" would let
 * the newest CVEs — the ones with no CVSS record yet — sort to the bottom of
 * the list on the day they matter most.
 */
export function severityFromLabel(label: string): { severity: number; unknown: boolean } {
  switch (label.trim().toLowerCase()) {
    case 'critical':
      return { severity: 5, unknown: false };
    case 'high':
      return { severity: 4, unknown: false };
    case 'medium':
      return { severity: 3, unknown: false };
    case 'low':
      return { severity: 2, unknown: false };
    case 'negligible':
      return { severity: 1, unknown: false };
    default:
      return { severity: 3, unknown: true };
  }
}

/**
 * The CVE for a match, from the four places one can appear.
 *
 * Ordered by how directly each states it: the id itself, then the explicit
 * related-vulnerability list, then the KEV and EPSS rows — which are keyed by
 * CVE, so a match carrying either is telling us the CVE even when its own id
 * is a GHSA.
 */
export function cveIdFor(
  vulnerability: Record<string, unknown>,
  related: unknown[],
): string | null {
  const own = asString(vulnerability['id']);
  if (own && CVE_ID.test(own)) return own.toUpperCase();

  for (const entry of related) {
    const id = asString(asRecord(entry)['id']);
    if (id && CVE_ID.test(id)) return id.toUpperCase();
  }
  for (const key of ['knownExploited', 'epss']) {
    for (const entry of asArray(vulnerability[key])) {
      const cve = asString(asRecord(entry)['cve']);
      if (cve && CVE_ID.test(cve)) return cve.toUpperCase();
    }
  }
  return null;
}

/**
 * Every vulnerability id this match names, de-duplicated and sorted.
 *
 * The same four places cveIdFor reads, minus its CVE filter: an id that is not
 * a CVE is still an id this vulnerability is known by, and dropping it is what
 * would make a GHSA-only advisory unsearchable in our own store.
 */
export function idsFor(vulnerability: Record<string, unknown>, related: unknown[]): string[] {
  // VERBATIM, not upper-cased. A GHSA id is published in lower case and is the
  // string a reader will paste into a search box; rewriting its case here would
  // put `GHSA-8Q59-Q68H-6HV4` in front of them, which matches nothing anywhere
  // else. Case-insensitive COMPARISON is the alias grouper's job (aliases.ts),
  // and that is a different thing from case-insensitive storage.
  const ids = new Set<string>();
  const own = asString(vulnerability['id']);
  if (own) ids.add(own);
  for (const entry of related) {
    const id = asString(asRecord(entry)['id']);
    if (id) ids.add(id);
  }
  for (const key of ['knownExploited', 'epss']) {
    for (const entry of asArray(vulnerability[key])) {
      const cve = asString(asRecord(entry)['cve']);
      if (cve) ids.add(cve.toUpperCase());
    }
  }
  return [...ids].sort();
}

/** The EPSS probability for this match's CVE, or the first one on offer. */
function epssFor(vulnerability: Record<string, unknown>, cveId: string | null): number | null {
  const rows = asArray(vulnerability['epss']).map(asRecord);
  const forCve = cveId
    ? rows.find((row) => asString(row['cve'])?.toUpperCase() === cveId)
    : undefined;
  const chosen = forCve ?? rows[0];
  const score = chosen?.['epss'];
  return typeof score === 'number' ? score : null;
}

/**
 * Parses one `grype -o json` document.
 *
 * THROWS on unreadable input rather than returning an empty match list: a
 * scanner that cannot read its tool's output has produced no findings, not zero
 * findings, and the caller fails the scan run on it.
 */
export function parseGrypeMatches(json: string): ParsedMatches {
  const parsed: unknown = JSON.parse(json);
  const document = asRecord(parsed);
  const raw = document['matches'];
  if (!Array.isArray(raw)) {
    throw new Error('grype output has no matches array');
  }

  const funnel: MatchFunnel = {
    rawMatches: raw.length,
    duplicatesCollapsed: 0,
    withoutCveId: 0,
    unknownSeverity: 0,
  };

  // Keyed by (purl, CVE). nvd and github both carry the same vulnerability for
  // the same package, so an unkeyed list hands a reader two rows for one
  // problem. The collapse is COUNTED, because a silent one is a cap.
  const byKey = new Map<string, DependencyMatch>();

  for (const entry of raw) {
    const match = asRecord(entry);
    const vulnerability = asRecord(match['vulnerability']);
    const artifact = asRecord(match['artifact']);
    const related = asArray(match['relatedVulnerabilities']);

    const vulnerabilityId = asString(vulnerability['id']);
    const packageName = asString(artifact['name']);
    if (!vulnerabilityId || !packageName) continue;

    const cveId = cveIdFor(vulnerability, related);
    const label = asString(vulnerability['severity']) ?? 'Unknown';
    const { severity, unknown } = severityFromLabel(label);
    if (unknown) funnel.unknownSeverity += 1;
    if (!cveId) funnel.withoutCveId += 1;

    const record: DependencyMatch = {
      vulnerabilityId,
      ids: idsFor(vulnerability, related),
      cveId,
      severityLabel: label,
      severity,
      // Non-empty knownExploited IS the KEV correlation. The list is CISA's,
      // and it says the vulnerability has been exploited in the wild — which
      // is why price.ts stops predicting and sets likelihood to 1.
      kev: asArray(vulnerability['knownExploited']).length > 0,
      epss: epssFor(vulnerability, cveId),
      purl: asString(artifact['purl']),
      packageName,
      packageVersion: asString(artifact['version']) ?? '',
      packageType: asString(artifact['type']) ?? 'unknown',
      locations: asArray(artifact['locations'])
        .map((location) => asString(asRecord(location)['path']))
        .filter((path): path is string => path !== null),
      fixVersions: asArray(asRecord(vulnerability['fix'])['versions']).filter(
        (version): version is string => typeof version === 'string',
      ),
      matchType: asString(asRecord(asArray(match['matchDetails'])[0])['type']) ?? 'unknown',
    };

    const key = `${record.purl ?? record.packageName} ${cveId ?? vulnerabilityId}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, record);
      continue;
    }
    funnel.duplicatesCollapsed += 1;
    // Keep the WORSE of the two. Two providers disagreeing about severity is
    // ordinary, and taking whichever arrived first would make our answer depend
    // on the order grype happened to walk its database.
    const winner = record.severity > prior.severity || (record.kev && !prior.kev) ? record : prior;
    // The id sets are UNIONED across the collapse regardless of which record
    // won (W8-13 V0). Keeping only the winner's ids would lose the provider id
    // the other half was filed under — which is the id half our readers have.
    winner.ids = [...new Set([...prior.ids, ...record.ids])].sort();
    byKey.set(key, winner);
  }

  return {
    matches: [...byKey.values()],
    funnel,
    grypeVersion: asString(asRecord(document['descriptor'])['version']),
  };
}
