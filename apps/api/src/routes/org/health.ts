import { readMetricTrend } from '@repopulse/metrics';
import {
  buildHealthSubScores,
  computeHealthScore,
  scoreLetter,
  type HealthMetricInputs,
  type HealthScore,
} from '@repopulse/insights';
import type { Database } from '@repopulse/shared';

// Repo health from the warehouse (FR-INSIGHTS-2/3): read each health-input
// metric's latest snapshot and feed the W3-11 score. Inputs the current
// snapshot set doesn't carry (commit-count-vs-median, flakiness, CFR) are null →
// excluded from their sub-score's mean (never scored 0).

const DAY_MS = 24 * 60 * 60 * 1000;

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

function dimNum(dims: Record<string, unknown>, path: string[]): number | null {
  let cur: unknown = dims;
  for (const k of path) {
    if (cur && typeof cur === 'object' && k in cur) cur = (cur as Record<string, unknown>)[k];
    else return null;
  }
  return typeof cur === 'number' ? cur : null;
}

export async function repoHealth(
  db: Database,
  workspaceId: number,
  repoId: number,
  window: string,
  pushedAt: Date | null,
  nowMs: number,
): Promise<HealthScore & { letter: string }> {
  const [m4, m5, m8, m9, m11] = await Promise.all([
    latest(db, workspaceId, repoId, 'M4', window),
    latest(db, workspaceId, repoId, 'M5', window),
    latest(db, workspaceId, repoId, 'M8', window),
    latest(db, workspaceId, repoId, 'M9', window),
    latest(db, workspaceId, repoId, 'M11', window),
  ]);

  const inputs: HealthMetricInputs = {
    commitCountVsMedian: null,
    daysSinceLastPush: pushedAt ? (nowMs - pushedAt.getTime()) / DAY_MS : null,
    m5ReviewCoverage: m5.value,
    medianFirstReviewHours: dimNum(m4.dims, ['stages', 'openToFirstReview', 'median']),
    stalePrCount: m8.value,
    m9PassRate: dimNum(m9.dims, ['passRate']) ?? m9.value,
    topFlakiness: null,
    e2eCycleP50Hours: m4.value,
    m11DaysSinceRelease: dimNum(m11.dims, ['daysSinceLast']),
    m12Cfr: null,
  };

  const score = computeHealthScore(buildHealthSubScores(inputs));
  return { ...score, letter: scoreLetter(score.score) };
}
