import type { DependencyMatch } from '../scanners/dependency/matches.js';
import { dedupeByAlias } from './aliases.js';
import { readResolvedSet, scopeEcosystemOf, scopeFor } from './scope.js';
import { scanImports, usageFor } from './usage.js';
import {
  reachabilityFor,
  type GoReachabilityResult,
  type GoVulnerability,
} from './reachability.js';
import {
  emptyFunnel,
  type ValidatedVulnerability,
  type ValidationFunnel,
  type VexProposal,
} from './types.js';

// The validation funnel, run in order (W8-13, SECURITY_SUITE.md §3.6).
//
// V0 dedups, V1 scopes, V2 asks whether it is imported, V3 asks whether it is
// reached. Each tier's input and output are COUNTED into one funnel object so
// the whole thing is reportable: "47 raw advisories → 31 vulnerabilities → 9
// prod-direct, 4 of them imported" is the credibility story, and it only works
// if every number in it can be reconciled against the finding rows.
//
// NOTHING HERE DISMISSES ANYTHING. `funnel.dismissed` is zero and a test
// asserts it: suppression needs a justification and a human (FR-SEC-14, W8-14),
// and a scanner that quietly suppressed its own findings would be the exact
// behaviour §3.6 exists to prevent.

export interface ValidateArgs {
  matches: readonly DependencyMatch[];
  /** The C1a snapshot for this SHA. Manifests and sources are read from it. */
  snapshotDir: string;
  /** V3's output, when a call-graph prover ran. Null when none did. */
  goReachability?: GoReachabilityResult | null;
  /**
   * grype's own match count, before parseGrypeMatches collapsed its (purl, CVE)
   * duplicates. Defaults to `matches.length`, which understates the raw figure
   * by however many that reader already merged.
   */
  rawMatchCount?: number;
}

export interface ValidationResult {
  vulnerabilities: ValidatedVulnerability[];
  funnel: ValidationFunnel;
  /** Manifests V1 actually read — reviewed files for the stale sweep. */
  manifests: string[];
  /** Source files V2 read, so a zero import count can be told from a zero scan. */
  filesScanned: number;
}

export function validateVulnerabilities(args: ValidateArgs): ValidationResult {
  const funnel = emptyFunnel();
  funnel.raw = args.rawMatchCount ?? args.matches.length;

  // --- V0 ----------------------------------------------------------------
  const { groups } = dedupeByAlias(args.matches);
  funnel.deduped = groups.length;
  funnel.withAliases = groups.filter((group) => group.aliases.length > 0).length;

  // --- V1 and V2 read the snapshot ONCE each, not once per finding --------
  const resolved = readResolvedSet(args.snapshotDir);
  const imports = scanImports(args.snapshotDir);

  const goProof = args.goReachability?.status === 'succeeded' ? args.goReachability : null;
  const goUnavailable = args.goReachability?.reason ?? null;

  const vulnerabilities = groups.map((group) => {
    const { match } = group;
    const ecosystem = scopeEcosystemOf(match.packageType);

    // --- V1 --------------------------------------------------------------
    const scope = scopeFor(resolved, match.packageType, match.packageName, match.packageVersion);
    if (scope.scope?.kind === 'prod-direct') funnel.scoped.prodDirect += 1;
    else if (scope.scope?.kind === 'prod-transitive') funnel.scoped.prodTransitive += 1;
    else if (scope.scope?.kind === 'dev') funnel.scoped.dev += 1;
    if (!scope.inResolvedSet) {
      if (scope.unreadableReason) funnel.scoped.unreadable += 1;
      else funnel.scoped.notInResolvedSet += 1;
    }
    if (scope.inResolvedSet && !scope.versionMatches) funnel.scoped.versionMismatch += 1;

    // --- V2 --------------------------------------------------------------
    const usage = usageFor(imports, ecosystem, match.packageName, scope.scope);
    if (usage.status === 'imported') funnel.usage.imported += 1;
    else if (usage.status === 'not_imported') funnel.usage.notImported += 1;
    else funnel.usage.unknown += 1;

    // --- V3 --------------------------------------------------------------
    const proof = goProof ? proofFor(goProof.vulnerabilities, group.match, group) : null;
    const reachability = reachabilityFor(
      usage.status,
      proof,
      // The reason is only attached when nothing PROVED anything: a verdict
      // that carries both a tier and an excuse for not having one reads as
      // less certain than it is.
      proof ? null : ecosystem === 'go' ? goUnavailable : reachabilityGap(ecosystem),
    );
    if (reachability.tier === 'symbol_reachable') funnel.reachability.symbolReachable += 1;
    else if (reachability.tier === 'proven_unreachable') funnel.reachability.provenUnreachable += 1;
    else if (reachability.tier === 'imported') funnel.reachability.imported += 1;
    else funnel.reachability.manifestOnly += 1;

    const proposals = proposalsFor(match.packageName, scope, usage, reachability);
    for (const proposal of proposals) {
      funnel.proposed[proposal.justification] = (funnel.proposed[proposal.justification] ?? 0) + 1;
    }

    return {
      primaryId: group.primaryId,
      aliases: group.aliases,
      cveId: match.cveId,
      packageName: match.packageName,
      packageVersion: match.packageVersion,
      packageType: match.packageType,
      purl: match.purl,
      severity: match.severity,
      severityLabel: match.severityLabel,
      kev: match.kev,
      epss: match.epss,
      fixVersions: match.fixVersions,
      locations: match.locations,
      matchType: match.matchType,
      scope,
      usage,
      reachability,
      proposals,
    } satisfies ValidatedVulnerability;
  });

  return {
    vulnerabilities,
    funnel,
    manifests: resolved.manifests,
    filesScanned: imports.filesScanned,
  };
}

/** Why V3 said nothing for an ecosystem that has no call-graph prover. */
function reachabilityGap(ecosystem: string | null): string {
  return (
    `no call-graph prover for ${ecosystem ?? 'this ecosystem'} — govulncheck is Go-only, and ` +
    `symbol-level OSV data for other ecosystems is not carried in grype's output`
  );
}

/**
 * The govulncheck record for a grype match, joined on ALIAS and module.
 *
 * Both halves are required. The alias join is what connects two tools that use
 * different id spaces (grype says CVE-2020-26160, govulncheck says
 * GO-2020-0017), and the module check stops one advisory's proof being
 * borrowed by a different package it also affects — jwt-go and jwt-go/v4 are
 * two modules under one GO id, and only one of them is in this tree.
 */
function proofFor(
  vulnerabilities: readonly GoVulnerability[],
  match: DependencyMatch,
  group: { primaryId: string; aliases: string[] },
): GoVulnerability | null {
  // UPPER-CASED ON BOTH SIDES. grype stores a GHSA id as published (lower case)
  // and govulncheck's alias list comes from a different publisher; comparing
  // them verbatim works only for CVEs, which are upper case by convention, and
  // would silently miss a GHSA-only join — the exact case this alias join
  // exists to cover.
  const ids = new Set(
    [group.primaryId, ...group.aliases, ...match.ids].map((id) => id.toUpperCase()),
  );
  return (
    vulnerabilities.find(
      (vulnerability) =>
        (ids.has(vulnerability.osvId.toUpperCase()) ||
          vulnerability.aliases.some((alias) => ids.has(alias.toUpperCase()))) &&
        vulnerability.modules.includes(match.packageName),
    ) ?? null
  );
}

/**
 * The VEX justifications this run PROPOSES. Proposals, not decisions.
 *
 * Each sentence is written for the person who has to agree or disagree with
 * it, and each states the LIMIT of what was checked. "We found no import" is
 * not "it cannot run", and a proposal that blurred the two would be talking a
 * reviewer into a dismissal the evidence does not support.
 */
function proposalsFor(
  packageName: string,
  scope: ValidatedVulnerability['scope'],
  usage: ValidatedVulnerability['usage'],
  reachability: ValidatedVulnerability['reachability'],
): VexProposal[] {
  const proposals: VexProposal[] = [];

  if (!scope.inResolvedSet && !scope.unreadableReason) {
    proposals.push({
      justification: 'component_not_present',
      statement:
        `${packageName} appears in the SBOM but in none of the lockfiles this scan read ` +
        `(${scope.manifest ?? 'no manifest resolved it'}). Either it does not ship, or the ` +
        `SBOM and the lockfile disagree — both are worth a look before this is accepted.`,
    });
  }

  if (reachability.tier === 'proven_unreachable') {
    proposals.push({
      justification: 'vulnerable_code_not_in_execute_path',
      statement:
        `${reachability.provenBy} built a call graph from this repository's own entry points ` +
        `and found no path to the vulnerable symbol in ${packageName}. This is a proof about ` +
        `statically resolvable calls; reflection and dynamically constructed calls are ` +
        `outside what it can see.`,
    });
    return proposals;
  }

  if (usage.status === 'not_imported') {
    proposals.push({
      justification: 'vulnerable_code_not_in_execute_path',
      statement:
        `No import statement in this repository's own sources names ${packageName}. That is ` +
        `not proof the code cannot run — a plugin loader, a framework convention scan, a ` +
        `build step or a dynamic require would all be invisible to this check — it is only ` +
        `the absence of a direct, statically written import.`,
    });
  }

  return proposals;
}
