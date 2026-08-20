import {
  RISK_MODEL_V1,
  RISK_MODEL_VERSION,
  bandFor,
  type RiskBand,
  type RiskModelConstants,
} from './model.js';

// The pricing function (W9-09, RISK_MODEL.md §2, FR-RISK-1/2/3).
//
// PURE, and deliberately so: the same finding must price the same way in the
// API, in the nightly reprice job and in a test. It is also the reason the
// decomposition can be served — the UI popover shows the arithmetic, and
// "recompute from what you were served" reproduces the stored number exactly.
//
// NO MODEL IS INVOLVED ANYWHERE IN PRICING. A score a model produced could not
// be reproduced, defended, or argued with, and this number decides what a team
// works on next.

export type FindingDimension =
  | 'security'
  | 'secrets'
  | 'dependency'
  // Non-CVE supply-chain health (W10-02). It prices on the CONFIDENCE branch
  // like every other finder — there is no EPSS for "this package is
  // abandoned" — but its EXPOSURE reuses the dependency scope factors,
  // because a dev-only abandoned package is exactly as much less exposed as a
  // dev-only CVE is.
  | 'dependency_health'
  | 'sast'
  | 'iac'
  | 'chain'
  | 'compound'
  | 'code_health'
  | 'logging'
  | 'performance'
  | 'test_coverage'
  // W10-04. Prices on the confidence branch with file exposure: a test gap in
  // a hot file matters more than the same gap in a cold one, which is exactly
  // what the hotspot percentile already expresses.
  | 'test_gap';

export type VerifyStatus = 'confirmed' | 'unverified' | 'contradicted';
export type Reachability = 'symbol_reachable' | 'imported' | 'manifest_only' | 'proven_unreachable';

export interface PricingInput {
  dimension: FindingDimension;
  /** 1-5, the canonical scale (ANALYSIS_TIERS §4). */
  severity: number;
  /** 1-5. */
  confidence: number;
  verifyStatus?: VerifyStatus | null;
  /** From the rule's lifecycle stats (W9-07). null = no stats yet. */
  ruleFpRate?: number | null;

  // --- dependency inputs. Absent is NOT zero: see likelihoodFor. ---
  epss?: number | null;
  kev?: boolean;
  depScope?: { kind: 'prod-direct' | 'prod-transitive' | 'dev'; depth?: number } | null;
  reachability?: Reachability | null;

  // --- exposure inputs for file-bound findings ---
  /** Repo-relative hotspot percentile of the file, 0-1. null = unknown. */
  hotspotPercentile?: number | null;
  /** True for findings with no file at all (policy, repo-level). */
  repoScoped?: boolean;

  // --- overrides ---
  verifiedSecret?: boolean;
}

export interface RiskFactors {
  H: number;
  L: number;
  X: number;
  inputs: Record<string, unknown>;
  model_version: string;
}

export interface PricedFinding {
  effectiveRisk: number;
  band: RiskBand;
  riskFactors: RiskFactors;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** H — how bad if it bites. */
export function hazardFor(severity: number): number {
  return clamp01(severity / 5);
}

/**
 * L — will it bite.
 *
 * The dependency branch and everything else are genuinely different questions.
 * For a CVE we have an exploit-prediction score and a known-exploited list; for
 * everything else the honest inputs are how sure the finder was, whether a
 * second opinion agreed, and how often this rule has been wrong before.
 */
export function likelihoodFor(
  input: PricingInput,
  constants: RiskModelConstants = RISK_MODEL_V1,
): number {
  // Overrides. Each is a case where the argument is already settled: a CVE on
  // the known-exploited list IS being exploited, a verified credential IS live,
  // and a chain or compound finding is an argument about findings that have
  // each been priced already.
  if (input.kev || input.verifiedSecret) return 1;
  if (input.dimension === 'chain' || input.dimension === 'compound') return 1;

  if (input.dimension === 'dependency') {
    // No EPSS and no KEV means we do not KNOW it is exploited — which is the
    // floor, not zero and not a guess. When the EPSS feed lands (W8-13), this
    // line starts returning a real number without anything else changing.
    const epss = input.epss ?? 0;
    return Math.max(epss, constants.dependencyLikelihoodFloor);
  }

  const verify = constants.verifyMultiplier[input.verifyStatus ?? 'unverified'];
  // A rule with no lifecycle stats is priced at 0.7, not 1.0: unmeasured is not
  // perfect, and pricing it as perfect would float every new rule to the top.
  const precision =
    input.ruleFpRate === null || input.ruleFpRate === undefined
      ? constants.precisionWithoutStats
      : Math.max(constants.precisionFloor, 1 - input.ruleFpRate);

  return clamp01((input.confidence / 5) * verify * precision);
}

/** X — does it sit where the code actually lives. */
export function exposureFor(
  input: PricingInput,
  constants: RiskModelConstants = RISK_MODEL_V1,
): number {
  if (input.dimension === 'dependency' || input.dimension === 'dependency_health') {
    const scope = input.depScope;
    let scopeMultiplier = constants.depScope.prodDirect;
    if (scope?.kind === 'dev') scopeMultiplier = constants.depScope.dev;
    else if (scope?.kind === 'prod-transitive') {
      scopeMultiplier = Math.max(
        constants.depScope.prodTransitiveFloor,
        constants.depScope.prodTransitiveBase -
          constants.depScope.prodTransitiveStep * Math.max(0, (scope.depth ?? 1) - 1),
      );
    }
    const reach = input.reachability
      ? constants.reachability[input.reachability]
      : // Unknown reachability is treated as manifest_only — we know it is in
        // the manifest, and claiming more than that would price an unproven
        // path as a proven one.
        constants.reachability.manifest_only;
    return clamp01(scopeMultiplier * reach);
  }

  // A repo-scoped finding has no file to be cold or hot; it applies to the
  // whole repository, so exposure is 1 rather than an averaged guess.
  if (
    input.repoScoped ||
    input.hotspotPercentile === null ||
    input.hotspotPercentile === undefined
  ) {
    return input.repoScoped ? 1 : constants.exposureFileRange.max;
  }

  const { min, max } = constants.exposureFileRange;
  // Floor at 0.25 so a critical finding in a cold file never disappears — it
  // ranks below the same finding in a hot one, which is the intent, and it
  // stays on the list, which is the honesty rule.
  return clamp01(min + (max - min) * clamp01(input.hotspotPercentile));
}

/** Price one finding. Deterministic, and reproducible from its own factors. */
export function priceFinding(
  input: PricingInput,
  constants: RiskModelConstants = RISK_MODEL_V1,
): PricedFinding {
  const H = hazardFor(input.severity);
  const L = likelihoodFor(input, constants);
  const X = exposureFor(input, constants);
  const effectiveRisk = Math.round(100 * H * L * X * 100) / 100;

  return {
    effectiveRisk,
    band: bandFor(
      effectiveRisk,
      {
        ...(input.kev !== undefined ? { kev: input.kev } : {}),
        ...(input.verifiedSecret !== undefined ? { verifiedSecret: input.verifiedSecret } : {}),
        chain: input.dimension === 'chain',
        compound: input.dimension === 'compound',
      },
      constants,
    ),
    riskFactors: {
      H,
      L,
      X,
      // The inputs travel with the score so the popover can show its working
      // and a reader can disagree with an input rather than with the number.
      inputs: {
        dimension: input.dimension,
        severity: input.severity,
        confidence: input.confidence,
        verify_status: input.verifyStatus ?? 'unverified',
        rule_fp_rate: input.ruleFpRate ?? null,
        epss: input.epss ?? null,
        kev: input.kev ?? false,
        dep_scope: input.depScope ?? null,
        reachability: input.reachability ?? null,
        hotspot_percentile: input.hotspotPercentile ?? null,
        repo_scoped: input.repoScoped ?? false,
        verified_secret: input.verifiedSecret ?? false,
      },
      model_version: RISK_MODEL_VERSION,
    },
  };
}

/**
 * Recompute a score from served factors.
 *
 * The honesty check the API's popover rests on: if this does not reproduce the
 * stored number, the decomposition shown to a user is not the arithmetic that
 * produced their score.
 */
export function recomputeFromFactors(factors: RiskFactors): number {
  return Math.round(100 * factors.H * factors.L * factors.X * 100) / 100;
}
