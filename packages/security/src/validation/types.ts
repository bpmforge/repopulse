import type { Reachability } from '@repopulse/insights';

// The CVE validation funnel — shared vocabulary (W8-13, SECURITY_SUITE.md §3.6,
// FR-SEC-13/15).
//
// A raw grype run over a real repository is a wall of CVEs, most of which do
// not apply. Each tier below removes a CLASS of noise and has to say what it
// removed and why: a funnel that silently drops findings is worse than no
// funnel, because it looks like a smaller problem rather than like a hidden
// one.
//
// THE RULE EVERY TIER IN THIS TICKET OBEYS: no tier dismisses anything. V0 is
// the only one that changes the row count, and it does it by MERGING two
// reports of one vulnerability. V1, V2 and V3 are CLASSIFICATIONS at constant
// population — they stamp a finding, they never remove it. Dismissal is
// VEX's job (W8-14), and it needs a human and a justification.

export type { Reachability };

/** OpenVEX justifications this funnel is able to PROPOSE (FR-SEC-14). */
export type VexJustification =
  | 'component_not_present'
  | 'vulnerable_code_not_present'
  | 'vulnerable_code_not_in_execute_path'
  | 'vulnerable_code_cannot_be_controlled_by_adversary'
  | 'inline_mitigations_already_exist';

/**
 * V2's answer, which has THREE values and not two.
 *
 * 'unknown' is the one that earns its place. The snapshot is a source tarball
 * with no installed tree in it, so the import scan sees only the repository's
 * OWN files: a transitive dependency is never named there even when it is
 * fully reachable through its parent, and several ecosystems name a package
 * differently from the module you import it as (pypi `pyyaml` is `import
 * yaml`). Reporting either of those as 'not_imported' would propose
 * `not_affected` on a live vulnerability, so both answer 'unknown' instead.
 */
export type UsageStatus = 'imported' | 'not_imported' | 'unknown';

export interface DepScope {
  kind: 'prod-direct' | 'prod-transitive' | 'dev';
  depth: number;
}

/** Where a claim came from, so a reader can disagree with the evidence. */
export interface UsageEvidence {
  file: string;
  line: number;
  /** The import statement itself, trimmed. */
  quote: string;
}

export interface CallSite {
  /** Snapshot-relative when the tool gave us a package path to join it to. */
  file: string;
  line: number;
  /** `MapClaims.VerifyAudience` — receiver included when the tool reported one. */
  symbol: string;
}

/** V1's answer for one vulnerable component. */
export interface ScopeVerdict {
  /** Did we find this package in a manifest's resolved dependency set at all? */
  inResolvedSet: boolean;
  /**
   * Resolved set says this package, at THIS version.
   *
   * False with `inResolvedSet: true` is the interesting case: the SBOM and the
   * lockfile disagree about which version is installed, and the CVE was matched
   * against the SBOM's answer.
   */
  versionMatches: boolean;
  /** null when the package is not in any resolved set we could read. */
  scope: DepScope | null;
  /** The manifest that resolved it — the file a reader should open. */
  manifest: string | null;
  /** Stated when we could not read a manifest for this ecosystem at all. */
  unreadableReason: string | null;
}

/** V2's answer. */
export interface UsageVerdict {
  status: UsageStatus;
  /** Why 'unknown', in a sentence. null when the answer is not 'unknown'. */
  unknownReason: string | null;
  evidence: UsageEvidence[];
}

/** V3's answer. */
export interface ReachabilityVerdict {
  tier: Reachability;
  /** The tool that proved it, or null when nothing beyond V2 ran. */
  provenBy: string | null;
  /** Stated whenever a call-graph prover was not available for this ecosystem. */
  unavailableReason: string | null;
  callSites: CallSite[];
}

/**
 * A proposal for W8-14 to act on. NEVER acted on here.
 *
 * The distinction is the whole of FR-SEC-13's trust argument: unjustified
 * suppression is how security tools lose developers, and a scanner that
 * silently dismissed its own findings would be doing exactly that with nobody
 * in the loop.
 */
export interface VexProposal {
  justification: VexJustification;
  /** The sentence a human triaging this would need to agree or disagree with. */
  statement: string;
}

/** One vulnerability, after every tier has had its say. */
export interface ValidatedVulnerability {
  /** Preferred identifier — the CVE when the alias set carries one. */
  primaryId: string;
  /** Every OTHER id this vulnerability is known by, sorted. */
  aliases: string[];
  cveId: string | null;
  packageName: string;
  packageVersion: string;
  packageType: string;
  purl: string | null;
  severity: number;
  severityLabel: string;
  kev: boolean;
  epss: number | null;
  fixVersions: string[];
  locations: string[];
  matchType: string;
  scope: ScopeVerdict;
  usage: UsageVerdict;
  reachability: ReachabilityVerdict;
  /** Proposals only — see VexProposal. Empty is the common case. */
  proposals: VexProposal[];
}

/**
 * The funnel, as counts a reader can reconcile (FR-SEC-15).
 *
 * `raw` and `deduped` are a genuine narrowing; everything after them is a
 * BREAKDOWN of the same `deduped` population, and is reported as buckets for
 * that reason. Rendering V1/V2/V3 as descending numbers would claim the funnel
 * dropped findings it never dropped — the same honesty failure as dropping
 * them silently, pointed the other way.
 */
export interface ValidationFunnel {
  /**
   * Advisories in, before anything collapsed one.
   *
   * The grype document's own match count when the caller passes it, because
   * that is the number a reader compares our answer against — "47 raw
   * advisories" is what the tool said, and starting the funnel at a figure our
   * own reader had already trimmed would understate what was filtered.
   */
  raw: number;
  /** Vulnerabilities out of V0. `raw - deduped` were alias twins. */
  deduped: number;
  /** Of those, how many carry at least one alias beyond their primary id. */
  withAliases: number;
  scoped: {
    prodDirect: number;
    prodTransitive: number;
    dev: number;
    /** In no resolved set we could read — evidence for W8-14, never a dismissal. */
    notInResolvedSet: number;
    /** SBOM version and lockfile version disagree. */
    versionMismatch: number;
    /** No manifest for this ecosystem could be read. Not the same as absent. */
    unreadable: number;
  };
  usage: { imported: number; notImported: number; unknown: number };
  reachability: {
    symbolReachable: number;
    provenUnreachable: number;
    imported: number;
    manifestOnly: number;
  };
  /** Proposed VEX justifications, by justification. Nothing is dismissed here. */
  proposed: Record<string, number>;
  /** ALWAYS ZERO in this ticket, and asserted to be. Dismissal is W8-14's. */
  dismissed: number;
}

export function emptyFunnel(): ValidationFunnel {
  return {
    raw: 0,
    deduped: 0,
    withAliases: 0,
    scoped: {
      prodDirect: 0,
      prodTransitive: 0,
      dev: 0,
      notInResolvedSet: 0,
      versionMismatch: 0,
      unreadable: 0,
    },
    usage: { imported: 0, notImported: 0, unknown: 0 },
    reachability: {
      symbolReachable: 0,
      provenUnreachable: 0,
      imported: 0,
      manifestOnly: 0,
    },
    proposed: {},
    dismissed: 0,
  };
}
