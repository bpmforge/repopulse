import type { IncomingFinding } from '@repopulse/insights';
import { readComponents, resolveScopes, type ResolvedComponent } from '../../registers/sbom.js';
import type { DependencyMatch } from './matches.js';

// Vulnerability matches -> stored findings (W8-06, FR-SEC-5, D12).
//
// Pure. The whole of the risk-model contract this scanner has to honour lives
// in this file, so a change to it is a change to a diff someone can read rather
// than to a container command nobody can run locally.

export const DEPENDENCY_SCANNER_KEY = 'dependency_cve';

export interface FindingFunnel {
  /** Matches handed to this mapper. */
  matches: number;
  /**
   * Components the scope index could actually read — npm and pypi purls only.
   *
   * Reported next to the document's own component count because the two are
   * different numbers and a reader comparing them would otherwise have no way
   * to tell an ecosystem we cannot scope from one that is not there.
   */
  syncableComponents: number;
  /** Findings produced. Equal to `matches` unless something below dropped one. */
  findings: number;
  /**
   * Matches whose package could not be located in the SBOM's scope index
   * (W8-06). NOT dropped: they are priced at unknown scope, which prices them
   * as prod-direct. resolveScopes admits only pkg:npm and pkg:pypi, and grype
   * matches every ecosystem it has a database for, so a maven or go finding
   * lands here — and dropping it would make a Java repository look clean.
   */
  withoutScope: number;
  /** KEV matches whose severity this floored to 4. */
  kevFloored: number;
}

export interface DependencyFindingsResult {
  findings: IncomingFinding[];
  funnel: FindingFunnel;
  /**
   * Manifest and lockfile paths this scan actually read.
   *
   * They are the `reviewedFiles` for the stale sweep: a CVE that a later scan
   * of the SAME manifests no longer reports has been patched away, and without
   * a reviewed-file list persistFindings has no basis on which to close it.
   */
  reviewedFiles: string[];
}

/** `ecosystem\0name\0version` — the key resolveScopes can actually be joined on. */
function scopeKey(ecosystem: string, name: string, version: string | null): string {
  return `${ecosystem}\0${name}\0${version ?? ''}`;
}

/** grype's artifact type -> the ecosystem token resolveScopes speaks. */
function ecosystemOf(packageType: string): string | null {
  if (packageType === 'npm') return 'npm';
  if (packageType === 'python') return 'pypi';
  return null;
}

function indexScopes(document: Record<string, unknown>): Map<string, ResolvedComponent> {
  const index = new Map<string, ResolvedComponent>();
  for (const component of resolveScopes(document)) {
    index.set(scopeKey(component.ecosystem, component.name, component.version), component);
  }
  return index;
}

/** Every path syft recorded a component at, mount prefix stripped. */
export function manifestPaths(document: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  const components = Array.isArray(document['components']) ? document['components'] : [];
  for (const entry of components) {
    const properties = (entry as { properties?: { name?: string; value?: string }[] }).properties;
    for (const property of properties ?? []) {
      if (typeof property.name === 'string' && /^syft:location:\d+:path$/.test(property.name)) {
        if (typeof property.value === 'string') paths.add(property.value.replace(/^\/+/, ''));
      }
    }
  }
  return [...paths].sort();
}

/**
 * One finding per (package, CVE).
 *
 * REACHABILITY IS 'manifest_only', STATED RATHER THAN OMITTED. An SBOM says a
 * package is in the dependency tree. It does not say the vulnerable symbol is
 * imported, let alone called — that needs a call graph this scanner does not
 * build — so anything stronger would price an unproven path as a proven one.
 * Setting it explicitly rather than leaving it undefined costs nothing and puts
 * the claim into riskFactors.inputs, where a reader can see which claim was
 * made instead of inferring it from a default.
 *
 * SCOPE IS ALWAYS 'prod-direct' TODAY, and that is a limitation of the reader
 * rather than of the SBOM. syft's CycloneDX root component is the SCANNED
 * DIRECTORY (`type: 'file'`, name `/scan`), and its bom-ref never appears in
 * `dependencies[]`, so resolveScopes' walk starts from a node with no edges
 * and every component falls through to its depth-1 default. The graph is
 * genuinely there — `debug -> ms` is in the fixture — and the fix is one line
 * in registers/sbom.js (start from the ref that appears in no `dependsOn`),
 * which is outside this ticket's write scope. Pinned by a test so it cannot be
 * "fixed" without someone noticing the depth ramp start working.
 */
export function dependencyFindings(
  matches: readonly DependencyMatch[],
  sbomDocument: Record<string, unknown>,
): DependencyFindingsResult {
  const scopes = indexScopes(sbomDocument);
  const funnel: FindingFunnel = {
    matches: matches.length,
    syncableComponents: readComponents(sbomDocument).length,
    findings: 0,
    withoutScope: 0,
    kevFloored: 0,
  };

  const findings = matches.map((match) => {
    const ecosystem = ecosystemOf(match.packageType);
    const scope = ecosystem
      ? scopes.get(scopeKey(ecosystem, match.packageName, match.packageVersion))
      : undefined;
    if (!scope) funnel.withoutScope += 1;

    // KEV floors severity at 4 (the ticket's acceptance). This is a SEPARATE
    // lever from the one price.ts pulls: there, `kev: true` forces likelihood
    // to 1 and the act band regardless of severity. Two levers, because a
    // reader sorting by severity in the UI must also see a KEV finding near the
    // top, and the band alone would not put it there.
    const severity = match.kev ? Math.max(4, match.severity) : match.severity;
    if (match.kev && severity > match.severity) funnel.kevFloored += 1;

    const identifier = match.cveId ?? match.vulnerabilityId;
    const purl = match.purl ?? `${match.packageName}@${match.packageVersion}`;
    const fix =
      match.fixVersions.length > 0
        ? `Upgrade to ${match.fixVersions.join(' or ')}.`
        : 'No fixed version is published yet — the options are a workaround, a pin, or removal.';

    return {
      dimension: 'dependency',
      severity,
      // 5 for a version-range match on an exact package identity: that is a
      // comparison, not a judgement. A cpe-match is grype guessing which
      // product a name refers to, which is where its false positives live, so
      // it goes in at 3 and says so.
      confidence: match.matchType.startsWith('exact-') ? 5 : 3,
      // The lockfile the component was catalogued from. A CVE has no line, but
      // it does have a manifest, and pointing at it beats pointing nowhere —
      // it is also what lets the stale sweep close this finding once the
      // dependency is upgraded, since persistFindings can only auto-resolve
      // findings on files a run says it reviewed.
      //
      // THE COST, chosen with eyes open: openFindingDensity groups open
      // findings by file for hotspot ranking (FR-INSIGHTS-5), so a repository
      // with two hundred CVEs makes its lockfile the hottest file it has. That
      // is a wrong-looking hotspot list; the alternative is a null file, which
      // means no sweep, which means real CVEs staying open after they are
      // fixed. A misleading chart loses to findings that never close.
      file: match.locations[0]?.replace(/^\/+/, '') ?? null,
      lineStart: null,
      lineEnd: null,
      title: `${identifier} in ${match.packageName} ${match.packageVersion}`,
      // NO VOLATILE NUMBERS IN THE EVIDENCE. dedupKey normalizes digits out of
      // this string, so the EPSS score — which moves daily — must not live
      // here or it would key the same finding differently tomorrow. The
      // identity is carried by ruleId instead, which the scanner branch of the
      // key includes verbatim.
      evidenceQuote: `${purl} is affected by ${identifier}`,
      rationale:
        `${match.packageName} ${match.packageVersion} matches ${identifier} ` +
        `(${match.severityLabel}${match.kev ? ', on the CISA known-exploited list' : ''}` +
        `${match.epss !== null ? `, EPSS ${match.epss.toFixed(5)}` : ''}). ${fix}`,
      suggestedFix: match.fixVersions.length > 0 ? fix : null,
      scannerKey: DEPENDENCY_SCANNER_KEY,
      // The vulnerability id, not a constant: dedupKey normalizes digits out of
      // the evidence quote, so "CVE-2020-11023" and "CVE-2020-11022" on the
      // same package collapse to the same normalized string. Without the id
      // here, two distinct CVEs on one package would become one row.
      ruleId: identifier,
      cveId: match.cveId,
      yields: {
        // The chainer term (§3.4). `terms()` reads only keys set to `true`, so
        // everything else below is invisible to it — which is why the pricing
        // inputs can share this column without polluting the chain vocabulary.
        ...(match.cveId ? { [`vuln-dependency:${match.cveId}`]: true } : {}),
        // D12 pricing inputs. `kev` and `dep_scope` are read back by
        // repriceFindings today; `epss` and `reachability` are written in the
        // same shape priceFinding takes and are NOT yet read by reprice — see
        // the note in run.ts.
        ...(match.kev ? { kev: true } : {}),
        ...(match.epss !== null ? { epss: match.epss } : {}),
        ...(scope ? { dep_scope: { kind: scope.scope, depth: scope.depth } } : {}),
        reachability: 'manifest_only',
      },
    } satisfies IncomingFinding;
  });

  funnel.findings = findings.length;

  return { findings, funnel, reviewedFiles: manifestPaths(sbomDocument) };
}
