// Risk pricing constants (W9-09, RISK_MODEL.md §2/§3, FR-RISK-1).
//
// effective_risk = round(100 · H · L · X, 2)
//
// MULTIPLICATIVE, on the OWASP Risk Rating shape: a near-zero factor tanks the
// score, which is the point — a critical finding in code nobody runs is not a
// critical problem. The floors below are what stop anything vanishing
// entirely, because "tiny" and "gone" are different and only one of them is
// honest.
//
// Every constant is catalog-versioned and workspace-tunable. The version is
// stamped into each finding's risk_factors, so a score can always be explained
// by the model that produced it rather than by the model running today.

export const RISK_MODEL_VERSION = 'risk_model.v4';

export interface RiskModelConstants {
  /** Stamped into risk_factors; absent = RISK_MODEL_VERSION. */
  version?: string;
  /** Likelihood floor for a dependency finding with no exploit signal. */
  dependencyLikelihoodFloor: number;
  /**
   * v3: a dependency finding's likelihood is at least what the same evidence
   * would earn any other finding — confidence/5 × verify multiplier ×
   * precisionWithoutStats. Absent = EPSS alone (v1/v2).
   */
  dependencyLikelihoodFromEvidence?: boolean;
  /**
   * v4: a compound cluster is overridden to likelihood 1.0 and "act" only when
   * at least one of its member dimensions is a security one. Absent = every
   * compound cluster overrides (v1-v3).
   */
  compoundOverrideNeedsSecurity?: boolean;
  /** Verify-status multipliers (FR-ANALYSIS-9). */
  verifyMultiplier: { confirmed: number; unverified: number; contradicted: number };
  /** Rule-precision prior floor, and the value used when a rule has no stats. */
  precisionFloor: number;
  precisionWithoutStats: number;
  /** Hotspot percentile maps into this range — the floor is load-bearing. */
  exposureFileRange: { min: number; max: number };
  /** Dependency scope multipliers. */
  depScope: {
    prodDirect: number;
    prodTransitiveBase: number;
    prodTransitiveStep: number;
    prodTransitiveFloor: number;
    dev: number;
  };
  /** Reachability multipliers. */
  reachability: {
    symbol_reachable: number;
    imported: number;
    manifest_only: number;
    proven_unreachable: number;
  };
  /** Band thresholds. */
  bands: { act: number; schedule: number };
  /**
   * Import-graph exposure (W18-25). Absent = the model has no graph factor,
   * which is what v1 priced with.
   */
  importGraph?: {
    /** X multiplier for a file nothing imports (and that is not an entry point). */
    orphanMultiplier: number;
    /** Fan-in at or below this is neutral (1.0). */
    neutralFanIn: number;
    /** Fan-in at which the boost reaches maxMultiplier; log-scaled between. */
    saturateFanIn: number;
    maxMultiplier: number;
  };
}

export const RISK_MODEL_V1: RiskModelConstants = {
  version: 'risk_model.v1',
  dependencyLikelihoodFloor: 0.05,
  verifyMultiplier: { confirmed: 1.0, unverified: 0.7, contradicted: 0.15 },
  precisionFloor: 0.3,
  // 0.7 rather than 1.0 for a rule nobody has triaged: an unmeasured rule is
  // not a perfect rule, and pricing it as one would put every brand-new rule
  // at the top of the list on its first day.
  precisionWithoutStats: 0.7,
  exposureFileRange: { min: 0.25, max: 1.0 },
  depScope: {
    prodDirect: 1.0,
    prodTransitiveBase: 0.8,
    prodTransitiveStep: 0.05,
    prodTransitiveFloor: 0.5,
    dev: 0.35,
  },
  reachability: {
    symbol_reachable: 1.0,
    imported: 0.85,
    manifest_only: 0.6,
    // 0.2, not 0: a proof of unreachability is a proof about today's call
    // graph. Zero would remove the finding from every ordered list forever,
    // and the next refactor is what makes that wrong.
    proven_unreachable: 0.2,
  },
  bands: { act: 55, schedule: 25 },
};

/**
 * v2 = v1 + import-graph exposure (W18-25).
 *
 * The graph adjusts X; it never replaces the hotspot mapping. Churn says where
 * the code is CHANGING, fan-in says how much of the rest of the code RUNS
 * THROUGH it, and a cold utility imported by forty modules is exactly the file
 * the hotspot percentile alone under-prices. The result stays floored at
 * exposureFileRange.min, so "nothing imports this" can push a finding down to
 * where a cold file already sits and never below it.
 */
export const RISK_MODEL_V2: RiskModelConstants = {
  ...RISK_MODEL_V1,
  version: 'risk_model.v2',
  importGraph: {
    // 0.6, not lower: a file with no importer is as likely a CLI, a worker or
    // something loaded by a framework convention the path heuristics missed
    // as it is dead code.
    orphanMultiplier: 0.6,
    neutralFanIn: 2,
    saturateFanIn: 32,
    maxMultiplier: 1.3,
  },
};

/**
 * v3 = v2 with dependency likelihood on the same footing as everything else
 * (2026-10-28 walkthrough). SUPERSEDES D10's "EPSS is the likelihood" for the
 * dependency dimension, which D12 inherited unchanged (RISK_MODEL.md §2).
 *
 * D12's purpose is one ranking across every dimension, but its L meant two
 * different things: for code findings, how sure we are the finding is real
 * and bites (confidence × verify × rule precision); for a CVE, the 30-day
 * exploitation probability, floored at 0.05. EPSS is small for almost every
 * CVE, and this install has no EPSS feed at all, so every CVE sat at the
 * floor: a second-model-confirmed critical CVE in a direct production
 * dependency scored 3.0 ("track") under a test-gap finding at 23.5.
 *
 * v3 prices a CVE's likelihood as max(EPSS, floor, confidence/5 × verify ×
 * precisionWithoutStats): the version match grype makes is evidence like any
 * rule hit, priced with the same prior an unmeasured rule gets (0.7, no new
 * constant), and EPSS can only raise it. A confirmed CVE now reaches
 * "schedule" where its exposure warrants it; a contradicted one stays at the
 * bottom (×0.15). KEV and malicious packages still override to "act".
 */
export const RISK_MODEL_V3: RiskModelConstants = {
  ...RISK_MODEL_V2,
  version: 'risk_model.v3',
  dependencyLikelihoodFromEvidence: true,
};

/**
 * v4 = v3 with the compound override limited to clusters that include a
 * security dimension (owner decision, 2026-10-28 walkthrough).
 *
 * A file flagged by three or more kinds of check is a real signal, but on
 * outline the top of the Findings page filled with clusters made only of
 * complexity, duplication and test gaps, all forced to "act" above confirmed
 * CVEs. A code-health-only cluster now prices like any other finding on its
 * own confidence and exposure: still listed, no longer top priority by fiat.
 */
export const RISK_MODEL_V4: RiskModelConstants = {
  ...RISK_MODEL_V3,
  version: RISK_MODEL_VERSION,
  compoundOverrideNeedsSecurity: true,
};

/**
 * Member dimensions that let a compound cluster override to "act" under v4:
 * the security axis (SECURITY_DIMENSIONS) without the chainer's own outputs.
 */
export const COMPOUND_SECURITY_DIMENSIONS: readonly string[] = [
  'security',
  'secrets',
  'sast',
  'iac',
  'dependency',
];

export type RiskBand = 'act' | 'schedule' | 'track';

/**
 * Band from a score, with overrides.
 *
 * An override goes straight to `act` regardless of arithmetic: a KEV-listed
 * CVE, a verified live credential, an installed malicious package (installing
 * it IS the compromise), an attack chain and a compound cluster are
 * all things where the score is a summary of an argument that has already been
 * made.
 */
export function bandFor(
  effectiveRisk: number,
  overrides: {
    kev?: boolean;
    verifiedSecret?: boolean;
    chain?: boolean;
    compound?: boolean;
    maliciousPackage?: boolean;
  } = {},
  constants: RiskModelConstants = RISK_MODEL_V4,
): RiskBand {
  if (
    overrides.kev ||
    overrides.verifiedSecret ||
    overrides.chain ||
    overrides.compound ||
    overrides.maliciousPackage
  ) {
    return 'act';
  }
  if (effectiveRisk >= constants.bands.act) return 'act';
  if (effectiveRisk >= constants.bands.schedule) return 'schedule';
  return 'track';
}
