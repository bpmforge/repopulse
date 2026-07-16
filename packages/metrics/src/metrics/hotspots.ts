import { daysBetween } from '../engine/windows.js';
import { isEligibleForChurn } from '../engine/exclusions.js';
import type { ChurnFileTouch } from './churn.js';

// METRICS.md §1 M2 (v1 MVP only - hotspot_v2 complexity proxy is a v1.x
// config-flagged extension, explicitly NOT implemented here).
export interface HotspotDecomposition {
  path: string;
  gross: number;
  normChurn: number;
  daysSince: number;
  decay: number;
  score: number;
  /** Eligible commit shas that contributed to gross - drill-down (FR-METRICS-2). */
  contributingShas: readonly string[];
}

const HOTSPOT_DECAY_HALF_LIFE_DAYS = 30;

/** METRICS.md §1 M2: hotspot(f) = normChurn(f) × 2^(−daysSince/30). */
export function computeHotspots(
  touches: readonly ChurnFileTouch[],
  asOf: Date,
  botGlobs?: readonly string[],
): HotspotDecomposition[] {
  const eligible = touches.filter((t) =>
    isEligibleForChurn(
      { authorLogin: t.authorLogin, parentShaCount: t.parentShaCount, superseded: t.superseded },
      botGlobs,
    ),
  );

  const byPath = new Map<string, ChurnFileTouch[]>();
  for (const t of eligible) {
    const bucket = byPath.get(t.path);
    if (bucket) bucket.push(t);
    else byPath.set(t.path, [t]);
  }

  const grossByPath = new Map<string, number>();
  for (const [path, ts] of byPath) {
    grossByPath.set(
      path,
      ts.reduce((sum, t) => sum + t.additions + t.deletions, 0),
    );
  }
  // max=0 (no eligible touches at all) => every normChurn is 0, per METRICS.md §1 M2.
  const maxGross = Math.max(0, ...grossByPath.values());

  return [...byPath.entries()].map(([path, ts]) => {
    const gross = grossByPath.get(path) as number;
    const lastTouchedAt = ts.reduce(
      (latest, t) => (new Date(t.touchedAt) > latest ? new Date(t.touchedAt) : latest),
      new Date(ts[0]!.touchedAt),
    );
    const daysSince = daysBetween(lastTouchedAt, asOf);
    const normChurn = maxGross === 0 ? 0 : gross / maxGross;
    const decay = Math.pow(2, -daysSince / HOTSPOT_DECAY_HALF_LIFE_DAYS);
    return {
      path,
      gross,
      normChurn,
      daysSince,
      decay,
      score: normChurn * decay,
      contributingShas: [...new Set(ts.map((t) => t.sha))],
    };
  });
}
