import { readMetricTrend } from '@repopulse/metrics';
import {
  buildHealthSubScores,
  computeHealthScore,
  healthInputsFromSnapshots,
  scoreLetter,
  FINDINGS_METRIC_KEY,
  type HealthScore,
} from '@repopulse/insights';
import type { Database } from '@repopulse/shared';
import { readWorkspaceSettings } from '../../lib/workspace-settings.js';

// Repo health from the warehouse (FR-INSIGHTS-2/3): read each health-input
// metric's latest snapshot and feed the W3-11 score. Inputs the current
// snapshot set doesn't carry (commit-count-vs-median, flakiness, CFR) are null →
// excluded from their sub-score's mean (never scored 0).

async function latest(
  db: Database,
  workspaceId: number,
  repoId: number,
  metricKey: string,
  window: string,
): Promise<{ value: number | null; dims: Record<string, unknown> }> {
  const [row] = await readMetricTrend(db, { workspaceId, repoId, metricKey, window, limit: 1 });
  return row ? { value: Number(row.value), dims: row.dims } : { value: null, dims: {} };
}

export async function repoHealth(
  db: Database,
  workspaceId: number,
  repoId: number,
  window: string,
  pushedAt: Date | null,
  nowMs: number,
): Promise<HealthScore & { letter: string }> {
  const [m4, m5, m8, m9, m11, findings] = await Promise.all([
    latest(db, workspaceId, repoId, 'M4', window),
    latest(db, workspaceId, repoId, 'M5', window),
    latest(db, workspaceId, repoId, 'M8', window),
    latest(db, workspaceId, repoId, 'M9', window),
    latest(db, workspaceId, repoId, 'M11', window),
    // W10-05: the FINDINGS row the snapshot job now writes. Before it existed
    // this route passed NO findings inputs at all, so the security and
    // code-health sub-scores were absent for every repo in the product while
    // their unit tests passed against hand-built metric sets.
    latest(db, workspaceId, repoId, FINDINGS_METRIC_KEY, window),
  ]);

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
    { M4: m4, M5: m5, M8: m8, M9: m9, M11: m11 },
    { pushedAt, nowMs },
    {
      openFindingDensity: null,
      worstOpenSeverity: null,
      slopDensity: num('slopDensity'),
      supplyChainRisk: num('dependencyHealthRiskSum'),
      eolRuntimeCount: num('eolRuntimeCount'),
    },
  );

  // W4-09: weights come from workspace config, not code (METRICS.md §3).
  // buildHealthSubScores falls back to DEFAULT_WEIGHTS per key, so an unset
  // workspace scores exactly as before.
  const { effective } = await readWorkspaceSettings(db, workspaceId);
  const score = computeHealthScore(buildHealthSubScores(inputs, effective.healthWeights));
  return { ...score, letter: scoreLetter(score.score) };
}
