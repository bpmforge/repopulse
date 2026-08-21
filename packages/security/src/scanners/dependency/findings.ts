import {
  dedupKey,
  priceFinding,
  type IncomingFinding,
  type PricedFinding,
  type PricingInput,
} from '@repopulse/insights';
import { readComponents } from '../../registers/sbom.js';
import type { ValidatedVulnerability } from '../../validation/index.js';

// Validated vulnerabilities -> stored findings (W8-06 + W8-13, FR-SEC-5/13, D12).
//
// Pure. The whole of the risk-model contract this scanner has to honour lives
// in this file, so a change to it is a change to a diff someone can read rather
// than to a container command nobody can run locally.
//
// W8-13 CHANGED THE INPUT and not much else. This used to map grype matches
// straight to findings, claiming `reachability: 'manifest_only'` on every one
// of them and taking dep_scope from the SBOM's (broken) scope walk. It now maps
// the output of the validation funnel, so the same fields carry what the tiers
// actually established: the alias set, whether the lockfile agrees the package
// ships, whether anything imports it, and whether a call graph reached it.
//
// V4 LIVES HERE TOO: each finding is priced through priceFinding — the SAME
// pure function the nightly reprice uses, imported rather than reimplemented,
// because two scoring paths for one number is how the popover stops matching
// the score it explains.

export const DEPENDENCY_SCANNER_KEY = 'dependency_cve';

export interface FindingFunnel {
  /** Validated vulnerabilities handed to this mapper. */
  matches: number;
  /**
   * Components the SBOM reader could parse — npm and pypi purls only.
   *
   * Reported next to the document's own component count because the two are
   * different numbers and a reader comparing them would otherwise have no way
   * to tell an ecosystem we cannot read from one that is not there.
   */
  syncableComponents: number;
  /** Findings produced. Equal to `matches` unless something below dropped one. */
  findings: number;
  /**
   * Matches V1 could not place in any resolved dependency set.
   *
   * NOT DROPPED: they are priced at unknown scope, which prices them as
   * prod-direct. A maven or an alpine finding lands here because this repo has
   * no manifest reader for those ecosystems, and dropping it would make a Java
   * repository look clean.
   */
  withoutScope: number;
  /** KEV matches whose severity this floored to 4. */
  kevFloored: number;
}

/** A finding and the score it was created with — see priceOne. */
export interface PricedIncomingFinding {
  finding: IncomingFinding;
  pricing: PricedFinding;
  /** Computed the way persistFindings computes it, so the row can be found again. */
  key: string;
}

export interface DependencyFindingsResult {
  priced: PricedIncomingFinding[];
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
 * One finding per validated vulnerability.
 *
 * REACHABILITY IS WHATEVER THE TIERS PROVED, and never more. 'manifest_only'
 * still means what it always meant — the package is in the dependency tree and
 * nothing beyond that was established — and it is still the answer for most
 * findings. What changed is that 'imported' and 'symbol_reachable' are now
 * REACHED rather than unreachable, each backed by evidence stored on the
 * finding, and 'proven_unreachable' is only ever set by a call-graph tool.
 */
export function dependencyFindings(
  vulnerabilities: readonly ValidatedVulnerability[],
  sbomDocument: Record<string, unknown>,
): DependencyFindingsResult {
  const funnel: FindingFunnel = {
    matches: vulnerabilities.length,
    syncableComponents: readComponents(sbomDocument).length,
    findings: 0,
    withoutScope: 0,
    kevFloored: 0,
  };

  const priced = vulnerabilities.map((vulnerability) => {
    if (!vulnerability.scope.scope) funnel.withoutScope += 1;

    // KEV floors severity at 4 (W8-06's acceptance). This is a SEPARATE lever
    // from the one price.ts pulls: there, `kev: true` forces likelihood to 1
    // and the act band regardless of severity. Two levers, because a reader
    // sorting by severity in the UI must also see a KEV finding near the top,
    // and the band alone would not put it there.
    const severity = vulnerability.kev
      ? Math.max(4, vulnerability.severity)
      : vulnerability.severity;
    if (vulnerability.kev && severity > vulnerability.severity) funnel.kevFloored += 1;

    return priceOne(vulnerability, severity);
  });

  funnel.findings = priced.length;

  return {
    priced,
    findings: priced.map((entry) => entry.finding),
    funnel,
    // THE SWEEP SET IS THE SBOM'S LOCATIONS, and deliberately NOT widened with
    // the manifests V1 read (W8-13). persistFindings auto-resolves any open
    // dependency finding whose file appears in this list, and `file` above comes
    // from the SBOM's locations — so the two lists have to be the same list.
    //
    // The widening was written first and reverted: V1's walker finds
    // requirements.txt and go.mod whether or not syft catalogued anything from
    // them, so a run whose python cataloguer produced nothing would still
    // declare requirements.txt reviewed and close every open python CVE as
    // fixed. That is the "a scanner that did not run marks live findings fixed"
    // failure W8-06 built its early return for, arriving through another door.
    // V1's manifest list is reported on the run result instead, where it
    // informs a reader without closing anything.
    reviewedFiles: manifestPaths(sbomDocument),
  };
}

function priceOne(vulnerability: ValidatedVulnerability, severity: number): PricedIncomingFinding {
  const identifier = vulnerability.primaryId;
  const purl = vulnerability.purl ?? `${vulnerability.packageName}@${vulnerability.packageVersion}`;
  const fix =
    vulnerability.fixVersions.length > 0
      ? `Upgrade to ${vulnerability.fixVersions.join(' or ')}.`
      : 'No fixed version is published yet — the options are a workaround, a pin, or removal.';

  // THE SBOM'S LOCATION STAYS FIRST, even though V1 now knows a manifest too.
  // `file` is part of the dedup key, so changing which of the two wins would
  // re-key every dependency finding already in the store — the next scan would
  // create a duplicate of each, and every triage decision and occurrence count
  // would silently detach from its finding. V1's manifest is the fallback for
  // a component syft recorded no location for.
  const file =
    vulnerability.locations[0]?.replace(/^\/+/, '') ?? vulnerability.scope.manifest ?? null;

  const finding: IncomingFinding = {
    dimension: 'dependency',
    severity,
    // 5 for a version-range match on an exact package identity: that is a
    // comparison, not a judgement. A cpe-match is grype guessing which product
    // a name refers to, which is where its false positives live, so it goes in
    // at 3 and says so.
    confidence: vulnerability.matchType.startsWith('exact-') ? 5 : 3,
    // The manifest the component was resolved from. A CVE has no line, but it
    // does have a manifest, and pointing at it beats pointing nowhere — it is
    // also what lets the stale sweep close this finding once the dependency is
    // upgraded, since persistFindings can only auto-resolve findings on files
    // a run says it reviewed.
    //
    // THE COST, chosen with eyes open: openFindingDensity groups open findings
    // by file for hotspot ranking (FR-INSIGHTS-5), so a repository with two
    // hundred CVEs makes its lockfile the hottest file it has. That is a
    // wrong-looking hotspot list; the alternative is a null file, which means
    // no sweep, which means real CVEs staying open after they are fixed. A
    // misleading chart loses to findings that never close.
    file,
    lineStart: null,
    lineEnd: null,
    title: `${identifier} in ${vulnerability.packageName} ${vulnerability.packageVersion}`,
    // NO VOLATILE NUMBERS IN THE EVIDENCE. dedupKey normalizes digits out of
    // this string, so the EPSS score — which moves daily — must not live here
    // or it would key the same finding differently tomorrow. The identity is
    // carried by ruleId instead, which the scanner branch of the key includes
    // verbatim.
    evidenceQuote: `${purl} is affected by ${identifier}`,
    rationale: rationaleFor(vulnerability, fix),
    suggestedFix: vulnerability.fixVersions.length > 0 ? fix : null,
    scannerKey: DEPENDENCY_SCANNER_KEY,
    // The vulnerability id, not a constant: dedupKey normalizes digits out of
    // the evidence quote, so "CVE-2020-11023" and "CVE-2020-11022" on the same
    // package collapse to the same normalized string. Without the id here, two
    // distinct CVEs on one package would become one row. (The underlying
    // normaliser is the subject of W8-16; this is the workaround, not a fix.)
    ruleId: identifier,
    cveId: vulnerability.cveId,
    yields: {
      // The chainer term (§3.4). `terms()` reads only keys set to `true`, so
      // everything else below is invisible to it — which is why the pricing
      // inputs can share this column without polluting the chain vocabulary.
      //
      // ONLY THE CVE gets a term, not every alias: the chain vocabulary is a
      // shared namespace, and quietly doubling it with GHSA ids would make
      // chain rules match on an id nobody wrote a rule against.
      ...(vulnerability.cveId ? { [`vuln-dependency:${vulnerability.cveId}`]: true } : {}),
      ...(vulnerability.kev ? { kev: true } : {}),
      ...(vulnerability.epss !== null ? { epss: vulnerability.epss } : {}),
      ...(vulnerability.scope.scope
        ? {
            dep_scope: {
              kind: vulnerability.scope.scope.kind,
              depth: vulnerability.scope.scope.depth,
            },
          }
        : {}),
      reachability: vulnerability.reachability.tier,
      // V0-V3's evidence, stored so the UI and W8-14 can show WHY a tier says
      // what it says. A tier label with no evidence behind it is a claim a
      // reader has to take on faith, which is the thing this funnel exists to
      // stop being.
      ...(vulnerability.aliases.length > 0 ? { aliases: vulnerability.aliases } : {}),
      usage: vulnerability.usage.status,
      ...(vulnerability.usage.evidence.length > 0
        ? { usage_evidence: vulnerability.usage.evidence }
        : {}),
      ...(vulnerability.reachability.callSites.length > 0
        ? { call_sites: vulnerability.reachability.callSites }
        : {}),
      ...(vulnerability.proposals.length > 0
        ? // PROPOSED, and named so in the key. Nothing downstream may read this
          // as a decision: a dismissal needs a human and a VEX statement
          // (W8-14, FR-SEC-14).
          { proposed_vex: vulnerability.proposals }
        : {}),
    },
  };

  const input: PricingInput = {
    dimension: 'dependency',
    severity,
    confidence: finding.confidence,
    epss: vulnerability.epss,
    kev: vulnerability.kev,
    depScope: vulnerability.scope.scope
      ? { kind: vulnerability.scope.scope.kind, depth: vulnerability.scope.scope.depth }
      : null,
    reachability: vulnerability.reachability.tier,
    repoScoped: finding.file === null,
  };

  return {
    finding,
    pricing: priceFinding(input),
    key: dedupKey({
      dimension: finding.dimension,
      file: finding.file,
      evidenceQuote: finding.evidenceQuote,
      lineStart: finding.lineStart,
      scannerKey: finding.scannerKey ?? null,
      ruleId: finding.ruleId ?? null,
    }),
  };
}

/**
 * The sentence a developer reads first.
 *
 * Every tier that had something to say says it here, in the order it ran, and
 * each hedge is spelled out rather than compressed into a label: "not imported"
 * on its own reads as "safe", and that is the misreading this whole subsystem
 * is built to prevent.
 */
function rationaleFor(vulnerability: ValidatedVulnerability, fix: string): string {
  const parts = [
    `${vulnerability.packageName} ${vulnerability.packageVersion} matches ` +
      `${vulnerability.primaryId} (${vulnerability.severityLabel}` +
      `${vulnerability.kev ? ', on the CISA known-exploited list' : ''}` +
      `${vulnerability.epss !== null ? `, EPSS ${vulnerability.epss.toFixed(5)}` : ''}).`,
  ];

  if (vulnerability.aliases.length > 0) {
    parts.push(`Also known as ${vulnerability.aliases.join(', ')}.`);
  }

  const scope = vulnerability.scope;
  if (scope.scope && scope.manifest) {
    parts.push(
      `${scope.manifest} resolves it as a ${scope.scope.kind} dependency at depth ` +
        `${scope.scope.depth}${scope.versionMatches ? '' : ', at a DIFFERENT version than the SBOM reports'}.`,
    );
  } else if (scope.unreadableReason) {
    parts.push(`Dependency scope is unknown: ${scope.unreadableReason}.`);
  } else {
    parts.push(
      'No lockfile this scan read resolves this package, so either it does not ship or ' +
        'the SBOM and the lockfile disagree.',
    );
  }

  if (vulnerability.reachability.tier === 'symbol_reachable') {
    const site = vulnerability.reachability.callSites[0];
    parts.push(
      `${vulnerability.reachability.provenBy} traced a call to ${site?.symbol ?? 'the vulnerable symbol'}` +
        `${site ? ` from ${site.file}:${site.line}` : ''}.`,
    );
  } else if (vulnerability.reachability.tier === 'proven_unreachable') {
    parts.push(
      `${vulnerability.reachability.provenBy} found no call path from this repository to the ` +
        'vulnerable symbol — a proof about statically resolvable calls only.',
    );
  } else if (vulnerability.usage.status === 'imported') {
    const evidence = vulnerability.usage.evidence[0];
    parts.push(
      `It is imported${evidence ? ` at ${evidence.file}:${evidence.line}` : ''}; whether the ` +
        'vulnerable function itself is called was not established.',
    );
  } else if (vulnerability.usage.status === 'not_imported') {
    parts.push(
      "No import in this repository's own sources names it, which is not proof it cannot " +
        'run — a plugin loader or a dynamic require would be invisible to that check.',
    );
  } else if (vulnerability.usage.unknownReason) {
    parts.push(`Usage is unknown: ${vulnerability.usage.unknownReason}.`);
  }

  parts.push(fix);
  return parts.join(' ');
}
