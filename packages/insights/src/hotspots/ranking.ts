import { computeHotspots, readChurnTouches } from '@repopulse/metrics';
import type { Database } from '@repopulse/shared';

// Cross-repo hotspot ranking (FR-INSIGHTS-5). Reuses the M2 hotspot function
// (score = normChurn × 2^(−daysSince/30)) per repo, then ranks globally.
// Tier-1 inputs only for MVP — finding-density is a W6 add (deferred here).

export interface RankedHotspot {
  repoId: number;
  path: string;
  score: number;
  // score components (drill-down, FR-METRICS-2)
  gross: number;
  normChurn: number;
  daysSince: number;
  decay: number;
}

export interface RankHotspotsParams {
  repoIds: readonly number[];
  asOf: Date;
  windowDays: number;
  topN?: number;
  botGlobs?: readonly string[];
}

/** Compute hotspots per repo and return the globally top-ranked files. */
export async function rankHotspots(
  db: Database,
  params: RankHotspotsParams,
): Promise<RankedHotspot[]> {
  const windowStart = new Date(params.asOf.getTime() - params.windowDays * 24 * 60 * 60 * 1000);
  const all: RankedHotspot[] = [];
  for (const repoId of params.repoIds) {
    const touches = await readChurnTouches(db, repoId, windowStart);
    for (const h of computeHotspots(touches, params.asOf, params.botGlobs)) {
      all.push({
        repoId,
        path: h.path,
        score: h.score,
        gross: h.gross,
        normChurn: h.normChurn,
        daysSince: h.daysSince,
        decay: h.decay,
      });
    }
  }
  // Global rank: score desc, then repoId+path for a stable order on ties.
  all.sort((a, b) => b.score - a.score || a.repoId - b.repoId || a.path.localeCompare(b.path));
  return params.topN !== undefined ? all.slice(0, params.topN) : all;
}
