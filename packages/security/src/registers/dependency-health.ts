import type { ResolvedComponent } from './sbom.js';

// Dependency-health register (W10-02, FR-REG-2, D13 §2).
//
// NON-CVE dependency risk: how old, how abandoned, how deprecated, how far
// behind. None of it needs a vulnerability database, which is why this half of
// supply-chain health can exist while W8-06 waits for syft — and none of it
// pretends to be a CVE, which is why the dimension is `dependency_health` and
// not `dependency`.
//
// PURE. Every threshold is a named constant, every finding reproduces from a
// fixture, and nothing here reads a clock it was not handed.

export interface ReleaseFactsRow {
  ecosystem: string;
  package: string;
  latestVersion: string | null;
  latestReleaseAt: Date | null;
  deprecated: boolean;
  yanked: boolean | null;
  versionDates: Record<string, string>;
}

export interface DependencyHealthThresholds {
  /** Months since the newest release before a package counts as abandoned. */
  abandonedMonths: number;
  staleMonths: number;
  /** Per-dependency libyear at which a finding is raised. */
  libyearWarn: number;
  /** Repo-aggregate libyear at which the repo-level finding is raised. */
  libyearRepoWarn: number;
}

export const DEPENDENCY_HEALTH_DEFAULTS: DependencyHealthThresholds = {
  abandonedMonths: 24,
  staleMonths: 12,
  libyearWarn: 3,
  libyearRepoWarn: 50,
};

export type DependencyHealthSignal =
  | 'yanked'
  | 'deprecated'
  | 'abandoned'
  | 'stale'
  | 'major_lag'
  | 'libyear'
  | 'libyear_repo';

export interface DependencyHealthFinding {
  signal: DependencyHealthSignal;
  severity: number;
  /** null on the repo aggregate, which is about no single package. */
  package: string | null;
  ecosystem: string | null;
  scope: 'prod-direct' | 'prod-transitive' | 'dev' | null;
  depth: number | null;
  title: string;
  evidence: string;
  recommendation: string;
  ruleId: string;
}

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;

const monthsBetween = (from: Date, to: Date): number =>
  (to.getTime() - from.getTime()) / (DAY_MS * 30.44);

/** Years between two releases — the libyear definition, not an age. */
export function libyearFor(
  installedReleasedAt: Date | null,
  latestReleaseAt: Date | null,
): number | null {
  // NULL, not 0. A missing date means we could not measure this dependency,
  // and a zero would say "perfectly current" — the null-vs-zero conflation
  // that this codebase keeps having to fix.
  if (!installedReleasedAt || !latestReleaseAt) return null;
  const years = (latestReleaseAt.getTime() - installedReleasedAt.getTime()) / (DAY_MS * YEAR_DAYS);
  return years <= 0 ? 0 : Math.round(years * 100) / 100;
}

/** Leading integer of a version string; null when it is not a number. */
export function majorOf(version: string | null): number | null {
  if (!version) return null;
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Severity ramp.
 *
 * Dev-scoped findings drop one step and never go below 1: the same abandoned
 * package matters less in a test harness than in the request path, and the
 * D12 exposure factors handle the ranking, but the SEVERITY should not claim
 * a build-time dependency is as bad as a shipped one.
 */
function rampFor(base: number, scope: DependencyHealthFinding['scope']): number {
  return scope === 'dev' ? Math.max(1, base - 1) : base;
}

export interface DependencyHealthInput {
  components: readonly ResolvedComponent[];
  releaseMeta: readonly ReleaseFactsRow[];
  now: Date;
  thresholds?: DependencyHealthThresholds;
}

export interface DependencyHealthResult {
  findings: DependencyHealthFinding[];
  /** Components with no release_meta row — REPORTED so the denominator is known. */
  unmeasured: number;
  measured: number;
  repoLibyear: number | null;
}

export function dependencyHealthFindings(input: DependencyHealthInput): DependencyHealthResult {
  const thresholds = input.thresholds ?? DEPENDENCY_HEALTH_DEFAULTS;
  const meta = new Map(
    input.releaseMeta.map((row) => [`${row.ecosystem}:${row.package}`, row] as const),
  );

  const findings: DependencyHealthFinding[] = [];
  let unmeasured = 0;
  let measured = 0;
  let repoLibyear: number | null = null;

  for (const component of input.components) {
    const row = meta.get(`${component.ecosystem}:${component.name}`);
    if (!row) {
      unmeasured += 1;
      continue;
    }
    measured += 1;

    const where = `${component.ecosystem}:${component.name}@${component.version ?? 'unknown'}`;
    const common = {
      package: component.name,
      ecosystem: component.ecosystem,
      scope: component.scope,
      depth: component.depth,
    };

    if (row.yanked === true) {
      findings.push({
        ...common,
        signal: 'yanked',
        severity: rampFor(4, component.scope),
        title: `Yanked package in use: ${component.name}`,
        evidence: `${where} — the registry reports this release as yanked.`,
        recommendation: 'Move to a release the registry still stands behind.',
        ruleId: 'dependency_health.yanked',
      });
    }

    if (row.deprecated) {
      findings.push({
        ...common,
        signal: 'deprecated',
        severity: rampFor(3, component.scope),
        title: `Deprecated package: ${component.name}`,
        evidence: `${where} — the registry marks the latest release deprecated.`,
        recommendation: 'Read the deprecation notice and plan the replacement.',
        ruleId: 'dependency_health.deprecated',
      });
    }

    if (row.latestReleaseAt) {
      const age = monthsBetween(row.latestReleaseAt, input.now);
      if (age >= thresholds.abandonedMonths) {
        findings.push({
          ...common,
          signal: 'abandoned',
          severity: rampFor(3, component.scope),
          title: `Likely abandoned: ${component.name}`,
          evidence: `${where} — newest release ${row.latestVersion ?? '?'} was ${Math.floor(age)} months ago (${row.latestReleaseAt.toISOString().slice(0, 10)}).`,
          recommendation:
            'Confirm upstream is still maintained; if not, plan a replacement before a CVE forces one.',
          ruleId: 'dependency_health.abandoned',
        });
      } else if (age >= thresholds.staleMonths) {
        findings.push({
          ...common,
          signal: 'stale',
          severity: rampFor(2, component.scope),
          title: `No release in ${Math.floor(age)} months: ${component.name}`,
          evidence: `${where} — newest release ${row.latestVersion ?? '?'} dates from ${row.latestReleaseAt.toISOString().slice(0, 10)}.`,
          recommendation: 'Check whether upstream has moved, forked, or stopped.',
          ruleId: 'dependency_health.stale',
        });
      }
    }

    const installedMajor = majorOf(component.version);
    const latestMajor = majorOf(row.latestVersion);
    if (installedMajor !== null && latestMajor !== null && latestMajor > installedMajor) {
      const lag = latestMajor - installedMajor;
      findings.push({
        ...common,
        signal: 'major_lag',
        severity: rampFor(lag >= 2 ? 3 : 2, component.scope),
        title: `${lag} major version${lag === 1 ? '' : 's'} behind: ${component.name}`,
        evidence: `${where} — installed ${component.version}, latest ${row.latestVersion}.`,
        recommendation:
          'Upgrade one major at a time; the cost of each is smaller than the cost of all of them at once.',
        ruleId: 'dependency_health.major_lag',
      });
    }

    const installedAt = component.version ? row.versionDates[component.version] : undefined;
    const libyear = libyearFor(
      installedAt ? new Date(installedAt) : null,
      row.latestReleaseAt,
    );
    if (libyear !== null) {
      repoLibyear = (repoLibyear ?? 0) + libyear;
      if (libyear >= thresholds.libyearWarn) {
        findings.push({
          ...common,
          signal: 'libyear',
          severity: rampFor(2, component.scope),
          title: `${libyear} libyears behind: ${component.name}`,
          evidence: `${where} — installed ${component.version} released ${installedAt!.slice(0, 10)}; latest ${row.latestVersion} released ${row.latestReleaseAt!.toISOString().slice(0, 10)}.`,
          recommendation: 'Schedule the upgrade; libyears compound into a migration nobody wants.',
          ruleId: 'dependency_health.libyear',
        });
      }
    }
  }

  if (repoLibyear !== null) {
    repoLibyear = Math.round(repoLibyear * 100) / 100;
    if (repoLibyear >= thresholds.libyearRepoWarn) {
      findings.push({
        signal: 'libyear_repo',
        severity: 3,
        package: null,
        ecosystem: null,
        scope: null,
        depth: null,
        title: `Dependency set is ${repoLibyear} libyears behind`,
        evidence: `Summed over ${measured} measured dependencies${unmeasured > 0 ? `; ${unmeasured} had no registry data and are NOT in this total` : ''}.`,
        recommendation:
          'Set a libyear budget and hold it — the aggregate is the number that predicts the painful upgrade.',
        ruleId: 'dependency_health.libyear_repo',
      });
    }
  }

  return { findings, unmeasured, measured, repoLibyear };
}
