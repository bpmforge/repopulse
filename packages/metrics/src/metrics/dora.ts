import { median, nearestRankPercentile } from '../engine/percentiles.js';
import { ratio } from '../engine/ratio.js';
import { daysBetween } from '../engine/windows.js';

// METRICS.md §1 M12. Every result carries the doc's own honesty-caveat text
// verbatim (the acceptance's "every payload carries its basis label"),
// exactly as printed in that table - never re-derived or paraphrased.

function hoursBetween(a: Date, b: Date): number {
  return daysBetween(a, b) * 24;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

// --- Deployment frequency ---------------------------------------------

export interface DeploymentInput {
  environment: string;
  createdAt: string;
  latestStatus: string;
}

export interface ReleaseFallbackInput {
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

export type DeploymentFrequencyBasis = 'deployments' | 'releases';

export interface DeploymentFrequencyResult {
  basis: DeploymentFrequencyBasis;
  countInWindow: number;
  caveat: string;
}

const DEPLOYMENT_FREQUENCY_CAVEAT =
  'counts deploy records, not user-visible releases; env filter defaults to prod-like (prod*, config)';

/**
 * METRICS.md §1 M12: deployments with latestStatus=success per W; falls
 * back to releases (Gitea always falls back - no deployments API). The
 * fallback trigger is "zero deployment records exist at all" (not "zero
 * successful ones") - a repo with only failed/pending deployment records
 * still uses the deployments basis, just reporting 0 in the window.
 */
export function computeDeploymentFrequency(
  deployments: readonly DeploymentInput[],
  releases: readonly ReleaseFallbackInput[],
  windowStart: Date,
  windowEnd: Date,
  prodEnvGlob = 'prod*',
): DeploymentFrequencyResult {
  if (deployments.length === 0) {
    const eligible = releases.filter((r) => !r.isDraft && !r.isPrerelease);
    const countInWindow = eligible.filter((r) => {
      const at = new Date(r.publishedAt);
      return at >= windowStart && at <= windowEnd;
    }).length;
    return { basis: 'releases', countInWindow, caveat: DEPLOYMENT_FREQUENCY_CAVEAT };
  }

  const envPattern = globToRegExp(prodEnvGlob);
  const successfulProd = deployments.filter(
    (d) => d.latestStatus === 'success' && envPattern.test(d.environment),
  );
  const countInWindow = successfulProd.filter((d) => {
    const at = new Date(d.createdAt);
    return at >= windowStart && at <= windowEnd;
  }).length;
  return { basis: 'deployments', countInWindow, caveat: DEPLOYMENT_FREQUENCY_CAVEAT };
}

// --- Lead time for changes ---------------------------------------------

export interface DeploymentCommitInterval {
  /** D.createdAt for the deployment this commit is attributed to. */
  deployedAt: string;
  /** Merge time preferred via PR linkage; falls back to authored time (caller's responsibility to pick). */
  changeTime: string;
}

export interface LeadTimeResult {
  medianHours: number | null;
  p90Hours: number | null;
  caveat: string;
}

const LEAD_TIME_CAVEAT =
  'approximates "commit->running" using forge timestamps; no runtime confirmation';

/**
 * METRICS.md §1 M12: per deployment D, over commits C in (prev deploy of
 * same env, D], D.createdAt - C.mergedAt-or-authoredAt - pooled across all
 * deployments/commits (FR-METRICS-14's pooling principle: percentile
 * metrics pool raw samples, never average pre-computed per-group values).
 * Resolving "which commits belong to which deployment" needs the actual
 * git commit graph - the caller's job (ingest), not this pure function's;
 * it receives the already-attributed {deployedAt, changeTime} pairs.
 */
export function computeLeadTimeForChanges(
  intervals: readonly DeploymentCommitInterval[],
): LeadTimeResult {
  const hours = intervals.map((i) => hoursBetween(new Date(i.changeTime), new Date(i.deployedAt)));
  return {
    medianHours: median(hours),
    p90Hours: nearestRankPercentile(hours, 90),
    caveat: LEAD_TIME_CAVEAT,
  };
}

// --- Change-failure rate -------------------------------------------------

export interface CfrDeploymentInput {
  id: string;
  environment: string;
  createdAt: string;
}

export interface CfrCommitInput {
  sha: string;
  message: string;
  authoredAt: string;
  environment: string;
  isGithubRevertLinked: boolean;
}

export interface CfrResult {
  deployments: number;
  failedDeployments: number;
  cfr: number | null;
  /** Deployment ids counted as failed, for drill-down (acceptance: "counted commits exposed for drill-down"). */
  failedDeploymentIds: readonly string[];
  caveat: string;
}

const CFR_CAVEAT =
  'keyword heuristic; teams that don\'t say "hotfix" undercount; 48h window is a convention';

const REVERT_HOTFIX_PATTERN = /\b(revert|hotfix|rollback)\b/i;
const CFR_WINDOW_HOURS = 48;

/**
 * METRICS.md §1 M12: deployments followed <48h (same env) by a revert/
 * hotfix commit (message heuristic or GitHub revert linkage) / deployments.
 */
export function computeChangeFailureRate(
  deployments: readonly CfrDeploymentInput[],
  commits: readonly CfrCommitInput[],
): CfrResult {
  const failedDeploymentIds: string[] = [];

  for (const dep of deployments) {
    const deployedAt = new Date(dep.createdAt);
    const isFollowedByFailureSignal = commits.some((c) => {
      if (c.environment !== dep.environment) return false;
      const hoursAfter = hoursBetween(deployedAt, new Date(c.authoredAt));
      if (hoursAfter < 0 || hoursAfter >= CFR_WINDOW_HOURS) return false;
      return c.isGithubRevertLinked || REVERT_HOTFIX_PATTERN.test(c.message);
    });
    if (isFollowedByFailureSignal) failedDeploymentIds.push(dep.id);
  }

  return {
    deployments: deployments.length,
    failedDeployments: failedDeploymentIds.length,
    cfr: ratio(failedDeploymentIds.length, deployments.length).value,
    failedDeploymentIds,
    caveat: CFR_CAVEAT,
  };
}

// --- MTTR ----------------------------------------------------------------

export interface MttrResult {
  status: 'needs_incident_data';
  value: null;
  caveat: string;
}

const MTTR_CAVEAT = 'not computed in v1 - no incident source';

/** METRICS.md §1 M12: MTTR is never computed in v1 - never a fabricated number. */
export function computeMttr(): MttrResult {
  return { status: 'needs_incident_data', value: null, caveat: MTTR_CAVEAT };
}
