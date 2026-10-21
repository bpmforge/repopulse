import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import {
  buildHealthSubScores,
  computeHealthScore,
  healthInputsFromSnapshots,
  scoreLetter,
  FINDINGS_METRIC_KEY,
  securityInputsMany,
  type HealthScore,
} from '@repopulse/insights';
import { read, type Database } from '@repopulse/shared';
import { readWorkspaceSettings } from '../../lib/workspace-settings.js';

// Repo health from the warehouse (FR-INSIGHTS-2/3): read each health-input
// metric's latest snapshot and feed the W3-11 score. Inputs the current
// snapshot set doesn't carry (commit-count-vs-median, flakiness, CFR) are null →
// excluded from their sub-score's mean (never scored 0).

const HEALTH_METRIC_KEYS = ['M4', 'M5', 'M8', 'M9', 'M11', FINDINGS_METRIC_KEY] as const;

type Latest = { value: number | null; dims: Record<string, unknown> };
const ABSENT: Latest = { value: null, dims: {} };

export type RepoHealth = HealthScore & {
  letter: string;
  /**
   * The sub-scores that were DROPPED for want of inputs, with the weight each
   * would have carried (W20-12, UX_TODO DSH-19/80). computeHealthScore only
   * returns the survivors, so without this a score built from two parts of
   * seven read exactly like one built from all seven.
   */
  notMeasured: { key: string; weight: number }[];
};

/**
 * Whether the warehouse measured anything for this repository (W17-18).
 *
 * computeHealthScore sums contributions, so a repository whose every sub-score
 * was dropped for want of inputs sums an EMPTY set to 0 — a verdict nobody
 * reached. One predicate, so /repos, /repos/:id and the Overview's grid and
 * attention feed cannot disagree about it again (W20-05, UX_TODO DSH-08).
 */
export function isMeasured(health: HealthScore): boolean {
  return health.subScores.length > 0;
}

/**
 * Health for MANY repos in a bounded number of statements (W17-32).
 *
 * The per-repo version below used to issue six `readMetricTrend` reads plus a
 * settings read for every repository, and the three list routes called it in
 * a loop: 26 statements for the seeded 3 repos, 706 for 100. This reads every
 * (repo, metric) latest snapshot in ONE `DISTINCT ON` query and the workspace
 * settings once, so the count no longer grows with the repository list. The
 * scoring is unchanged — the single-repo function is this one with a list of
 * one, so the two cannot drift.
 */
export async function repoHealthMany(
  db: Database,
  workspaceId: number,
  repos: readonly { id: number; pushedAt: Date | null }[],
  window: string,
  nowMs: number,
  /**
   * W20-20 (UX_TODO DSH-18): score from the snapshots taken at or before this
   * instant, for the tile's change over the window. Absent = the latest.
   */
  asOf?: Date,
): Promise<Map<number, RepoHealth>> {
  const out = new Map<number, RepoHealth>();
  if (repos.length === 0) return out;

  const rows = await db
    .selectDistinctOn([read.metricSnapshots.repoId, read.metricSnapshots.metricKey], {
      repoId: read.metricSnapshots.repoId,
      metricKey: read.metricSnapshots.metricKey,
      value: read.metricSnapshots.value,
      dims: read.metricSnapshots.dims,
    })
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, workspaceId),
        inArray(
          read.metricSnapshots.repoId,
          repos.map((r) => r.id),
        ),
        inArray(read.metricSnapshots.metricKey, [...HEALTH_METRIC_KEYS]),
        eq(read.metricSnapshots.window, window),
        asOf ? lte(read.metricSnapshots.computedAt, asOf) : undefined,
      ),
    )
    // DISTINCT ON keeps the first row per (repo, metric) in this order — the
    // latest computed_at, exactly what readMetricTrend(limit: 1) returned.
    .orderBy(
      read.metricSnapshots.repoId,
      read.metricSnapshots.metricKey,
      desc(read.metricSnapshots.computedAt),
    );

  const latest = new Map<number, Map<string, Latest>>();
  for (const row of rows) {
    if (row.repoId === null) continue;
    let perRepo = latest.get(row.repoId);
    if (!perRepo) {
      perRepo = new Map();
      latest.set(row.repoId, perRepo);
    }
    perRepo.set(row.metricKey, { value: Number(row.value), dims: row.dims });
  }

  // W4-09: weights come from workspace config, not code (METRICS.md §3).
  // buildHealthSubScores falls back to DEFAULT_WEIGHTS per key, so an unset
  // workspace scores exactly as before.
  const { effective } = await readWorkspaceSettings(db, workspaceId);
  const securityInputs = await securityInputsMany(
    db,
    workspaceId,
    repos.map((r) => r.id),
  );

  for (const repo of repos) {
    const m = latest.get(repo.id) ?? new Map<string, Latest>();
    const get = (key: string): Latest => m.get(key) ?? ABSENT;
    // W10-05: the FINDINGS row the snapshot job now writes. Before it existed
    // this route passed NO findings inputs at all, so the security and
    // code-health sub-scores were absent for every repo in the product while
    // their unit tests passed against hand-built metric sets.
    const findings = get(FINDINGS_METRIC_KEY);

    // The mapping lives in @repopulse/insights (W5-03) so the report assembler
    // and this screen decompose a repo's score identically. Two copies would
    // drift silently, each self-consistent.
    const num = (key: string): number | null => {
      const value = findings.dims[key];
      // Absent stays NULL: an unwritten FINDINGS row must drop its sub-scores,
      // not score them as zero-risk.
      return typeof value === 'number' ? value : null;
    };

    const inputs = healthInputsFromSnapshots(
      { M4: get('M4'), M5: get('M5'), M8: get('M8'), M9: get('M9'), M11: get('M11') },
      { pushedAt: repo.pushedAt, nowMs },
      {
        // W20-09 (UX_TODO DSH-73): measured, or null when nothing has
        // examined this repository — never a silent null for everyone.
        openFindingDensity: securityInputs.get(repo.id)?.openFindingDensity ?? null,
        worstOpenSeverity: securityInputs.get(repo.id)?.worstOpenSeverity ?? null,
        slopDensity: num('slopDensity'),
        supplyChainRisk: num('dependencyHealthRiskSum'),
        eolRuntimeCount: num('eolRuntimeCount'),
      },
    );

    const defs = buildHealthSubScores(inputs, effective.healthWeights);
    const score = computeHealthScore(defs);
    const scored = new Set(score.subScores.map((s) => s.key));
    out.set(repo.id, {
      ...score,
      letter: scoreLetter(score.score),
      notMeasured: defs
        .filter((d) => !scored.has(d.key))
        .map((d) => ({ key: d.key, weight: d.weight })),
    });
  }
  return out;
}

export async function repoHealth(
  db: Database,
  workspaceId: number,
  repoId: number,
  window: string,
  pushedAt: Date | null,
  nowMs: number,
): Promise<RepoHealth> {
  const many = await repoHealthMany(db, workspaceId, [{ id: repoId, pushedAt }], window, nowMs);
  // Every requested repo gets an entry (unmeasured ones score from empty inputs).
  return many.get(repoId)!;
}
