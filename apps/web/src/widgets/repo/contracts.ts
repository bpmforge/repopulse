// Response shapes for the repo-scoped endpoints (W4-04). Hand-written for the
// same reason as widgets/org/contracts.ts: the API declares zod querystrings but
// no response schemas, so schema.gen.ts gives typed paths with no body. The
// handlers in apps/api/src/routes/{repos,prs,metrics} are the contract.

/** GET /repos/{id}?window= */
export interface RepoDetail {
  id: number;
  org: string;
  name: string;
  sync: string;
  health: {
    score: number;
    letter: string;
    /** 'Tier-1 only' until LLM analysis lands — shown, never hidden (UX_SPEC §1.4). */
    basis: string;
    /** Sub-score rows; the "why?" breakdown. Weight x normalized = contribution. */
    breakdown: { key: string; normalized: number; weight: number; contribution: number }[];
  };
  links: Record<string, string>;
}

/** GET /repos/{id}/hotspots?window= */
export interface RepoHotspots {
  items: { path: string; hotspot_score: number; links: { file: string } }[];
}

/** GET /repos/{id}/prs?state=&size_bucket=… */
export interface RepoPrs {
  items: {
    number: number;
    title: string;
    state: string;
    size_bucket: string;
    review_covered: boolean;
    links: { self: string };
  }[];
}

/** GET /metrics/series?metric_key=&window=&repo_id= — oldest-first. */
export interface MetricSeries {
  points: { computed_at: string; value: number | null }[];
  basis_label: string | null;
}

/** Size buckets in their natural order — METRICS.md M7, not alphabetical. */
export const SIZE_BUCKETS = ['XS', 'S', 'M', 'L', 'XL'] as const;

/** The repo Pulse trend charts (UX_SPEC §4.b): cycle time, churn, coverage, throughput. */
export const PULSE_METRICS = [
  { key: 'M4', label: 'PR cycle time', unit: 'h' },
  { key: 'M1', label: 'Commit churn', unit: 'lines' },
  { key: 'M5', label: 'Review coverage', unit: '%' },
  { key: 'M10', label: 'Issue throughput', unit: '' },
] as const;

/** Ratio metrics are stored 0..1 (METRICS.md); charts with a % axis must scale. */
export function scaleForUnit(value: number, unit: string): number {
  return unit === '%' ? value * 100 : value;
}

/** Group hotspot paths into a treemap: one node per top-level directory. */
export function toTreemap(
  items: RepoHotspots['items'],
): { name: string; value: number; children: { name: string; value: number; path: string }[] }[] {
  const dirs = new Map<string, { name: string; value: number; path: string }[]>();
  for (const item of items) {
    const segments = item.path.split('/');
    // Files at the repo root have no directory — group them under '/' rather
    // than dropping them, which would silently shrink the treemap's total.
    const dir = segments.length > 1 ? segments[0]! : '/';
    const leaf = {
      name: segments[segments.length - 1]!,
      value: item.hotspot_score,
      path: item.path,
    };
    dirs.set(dir, [...(dirs.get(dir) ?? []), leaf]);
  }
  return [...dirs.entries()]
    .map(([name, children]) => ({
      name,
      value: children.reduce((sum, c) => sum + c.value, 0),
      children,
    }))
    .sort((a, b) => b.value - a.value);
}
