import type { TrendPolarity } from '../../components/index.js';

// Response shapes for the four Org Overview endpoints.
//
// These are hand-written rather than derived from schema.gen.ts on purpose: the
// API declares zod QUERYSTRING schemas but no response schemas, so the generated
// OpenAPI document carries only `200: {description}` and the generated `paths`
// type has no body to give us. Until the routes gain response schemas, the
// handlers in apps/api/src/routes/{org,hotspots,metrics} are the contract, and
// these interfaces mirror them field-for-field. Keep them in sync; a response
// schema on those routes would let this file be deleted.

/** GET /org/summary?window= */
export interface OrgSummary {
  window: string;
  tiles: { metric_key: string; value: number | null; delta: number | null }[];
}

/** GET /org/health-tiles?window= */
export interface HealthTiles {
  items: {
    id: number;
    name: string;
    health: { score: number; letter: string; basis: string; delta: number | null };
  }[];
}

/** GET /org/attention?window=&since= */
export interface AttentionItems {
  items: { repo_id: number; name: string; kind: string; band: string }[];
}

/** GET /hotspots?window=&limit= */
export interface HotspotItems {
  items: { repoId: number; path: string; score: number }[];
}

/** GET /metrics/series?metric_key=&window= — oldest-first. */
export interface MetricSeries {
  points: { computed_at: string; value: number | null }[];
  basis_label: string | null;
}

/**
 * The five KPI tiles, in the order /org/summary returns them (its KPI_METRICS
 * const). Names and directions come from packages/metrics/src/catalog.ts —
 * `direction` there maps onto TrendDelta's polarity, which decides whether a
 * rise renders as good or bad. Getting that backwards would paint a CI
 * regression green, so it is spelled out per metric rather than defaulted.
 */
export const KPI_TILES: {
  key: string;
  label: string;
  unit: string | undefined;
  polarity: TrendPolarity;
}[] = [
  { key: 'M5', label: 'Review coverage', unit: '%', polarity: 'up-good' },
  { key: 'M9', label: 'CI pass rate', unit: '%', polarity: 'up-good' },
  { key: 'M4', label: 'PR cycle time', unit: 'h', polarity: 'down-good' },
  { key: 'M1', label: 'Commit churn', unit: 'lines', polarity: 'neutral' },
  { key: 'M10', label: 'Issue throughput', unit: undefined, polarity: 'up-good' },
];

/** Preformatted tile value — null renders an em dash, never a misleading 0 (UX §8). */
export function formatKpi(value: number | null, unit?: string): string | null {
  if (value === null) return null;
  // Ratio metrics (M5/M6/M9) are stored 0..1 by METRICS.md — rendering the raw
  // value beside a '%' unit produced "0.9 %" for 90% review coverage, which is
  // not merely ugly: it reads as catastrophically bad rather than good, and
  // "1 %" for a perfect CI pass rate reads as an outage.
  const scaled = unit === '%' ? value * 100 : value;
  return Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
}

/** GET /api/v1/me/context — identity + role for the caller (W4-14). */
export interface MeContext {
  workspace: { id: number; slug: string; name: string };
  role: 'admin' | 'member';
  identity_id: number | null;
  default_view_id: number | null;
}
