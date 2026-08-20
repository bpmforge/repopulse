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

export const RISK_MODEL_VERSION = 'risk_model.v1';

export interface RiskModelConstants {
  /** Likelihood floor for a dependency finding with no exploit signal. */
  dependencyLikelihoodFloor: number;
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
}

export const RISK_MODEL_V1: RiskModelConstants = {
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

export type RiskBand = 'act' | 'schedule' | 'track';

/**
 * Band from a score, with overrides.
 *
 * An override goes straight to `act` regardless of arithmetic: a KEV-listed
 * CVE, a verified live credential, an attack chain and a compound cluster are
 * all things where the score is a summary of an argument that has already been
 * made.
 */
export function bandFor(
  effectiveRisk: number,
  overrides: { kev?: boolean; verifiedSecret?: boolean; chain?: boolean; compound?: boolean } = {},
  constants: RiskModelConstants = RISK_MODEL_V1,
): RiskBand {
  if (overrides.kev || overrides.verifiedSecret || overrides.chain || overrides.compound) {
    return 'act';
  }
  if (effectiveRisk >= constants.bands.act) return 'act';
  if (effectiveRisk >= constants.bands.schedule) return 'schedule';
  return 'track';
}
