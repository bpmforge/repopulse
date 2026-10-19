// Response shapes for the repo-scoped endpoints (W4-04). Hand-written for the
// same reason as widgets/org/contracts.ts: the API declares zod querystrings but
// no response schemas, so schema.gen.ts gives typed paths with no body. The
// handlers in apps/api/src/routes/{repos,prs,metrics} are the contract.

/** "github.com" or "gitea · git.corp.example" (W20-15, UX_TODO X-16). */
export function forgeLabel(forge: { provider: string; host: string | null }): string {
  if (!forge.host) return forge.provider;
  return forge.host.includes(forge.provider) ? forge.host : `${forge.provider} · ${forge.host}`;
}

/** GET /repos/{id}?window= */
export interface RepoDetail {
  id: number;
  org: string;
  name: string;
  /** Which forge and host (W20-15, UX_TODO X-16). Optional for an older API. */
  forge?: { provider: string; host: string | null } | null;
  sync: string;
  /** W20-12 (UX_TODO DSH-24): when the forge was last read. Optional: older API. */
  last_synced_at?: string | null;
  /** W20-12 (UX_TODO DSH-48): the newest snapshot behind this page. */
  as_of?: string | null;
  health: {
    /** null when nothing has been measured (W20-05, UX_TODO DSH-08). */
    score: number | null;
    letter: string | null;
    measured?: boolean;
    /** 'Tier-1 only' until LLM analysis lands — shown, never hidden (UX_SPEC §1.4). */
    basis: string;
    /** Sub-score rows; the "why?" breakdown. Weight x normalized = contribution. */
    breakdown: {
      key: string;
      normalized: number;
      weight: number;
      contribution: number;
      /**
       * The measurements behind the sub-score (W16-21).
       *
       * Already sent by the API — `breakdown: health.subScores` carries them —
       * and simply never declared here, so the screen showed a normalised 0 with
       * nothing to explain it.
       */
      inputs?: { key: string; raw: number; good: number; bad: number; normalized: number }[];
    }[];
    /**
     * W20-12 (UX_TODO DSH-80): the sub-scores dropped for want of inputs, with
     * the weight each would have carried, and whether the rest were rescaled.
     * Optional: an older API omits them.
     */
    not_measured?: { key: string; weight: number }[];
    renormalized?: boolean;
  };
  links: Record<string, string>;
}

/** GET /repos/{id}/hotspots?window= */
export interface RepoHotspots {
  items: {
    path: string;
    hotspot_score: number;
    /** M2's parts (FR-METRICS-2). Optional: older API. W20-12 (DSH-20/21). */
    decomposition?: { gross: number; normChurn: number; daysSince: number; decay: number };
    /** Top author by lines changed, with their share. W20-12 (DSH-20). */
    top_owner?: { login: string; share: number } | null;
    links: { file: string };
  }[];
}

/** GET /repos/{id}/prs?state=&size_bucket=… */
export interface RepoPrs {
  items: {
    number: number;
    title: string;
    state: string;
    size_bucket: string;
    review_covered: boolean;
    /** Milestones, sent all along (W20-12, UX_TODO DSH-30). Optional: older API. */
    opened_at?: string;
    first_review_at?: string | null;
    first_approval_at?: string | null;
    merged_at?: string | null;
    links: { self: string };
  }[];
}

/**
 * The line-count bounds of each size bucket (METRICS.md §1 M7; the API's
 * SIZE_BUCKET_BOUNDS), for the histogram's legend (W20-12, UX_TODO DSH-30).
 */
export const SIZE_BUCKET_RANGE: Record<(typeof SIZE_BUCKETS)[number], string> = {
  XS: 'under 10 lines',
  S: '10–99',
  M: '100–499',
  L: '500–999',
  XL: '1,000+',
};

/** Median and p90 (nearest rank) of a list of hours; null when empty. */
export function stagePercentiles(hours: readonly number[]): {
  median: number | null;
  p90: number | null;
  n: number;
} {
  const sorted = [...hours].sort((a, b) => a - b);
  if (sorted.length === 0) return { median: null, p90: null, n: 0 };
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const p90 = sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)]!;
  return { median, p90, n: sorted.length };
}

/** GET /metrics/series?metric_key=&window=&repo_id= — oldest-first. */
export interface MetricSeries {
  points: {
    computed_at: string;
    value: number | null;
    /** A ratio's parts (W20-12, UX_TODO DSH-81); null for a non-ratio metric. */
    numerator?: number | null;
    denominator?: number | null;
  }[];
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

/**
 * The Performance tab's metrics (W17-19): the delivery numbers nothing else on
 * the repo screen shows. Cycle time, churn, coverage and throughput belong to
 * Pulse and CI duration belongs to the CI tab — repeating them here would be
 * two screens answering the same question with two renderings of it.
 */
export const DELIVERY_METRICS = [
  { key: 'M12', label: 'Deployment frequency', unit: 'per window' },
  { key: 'M11', label: 'Releases', unit: 'per window' },
] as const;

/**
 * The DORA components METRICS.md M12 names and v1 does NOT compute
 * (packages/metrics/src/catalog.ts: "MTTR (not computed in v1)"). Listed on the
 * tab rather than omitted: a DORA panel showing one of the four, silently, reads
 * as "your lead time is fine" — the same unmeasured-passes-for-measured defect
 * W17-18 removed from scoring.
 */
export const UNCOMPUTED_DORA = [
  'Lead time for changes',
  'Change failure rate',
  'Time to restore service',
] as const;

/**
 * How many rows each Activity section shows (W17-19). Five: enough to say what
 * is moving, few enough that the tab stays a digest and the "all →" link stays
 * the way to the full list rather than a second copy of it.
 */
export const ACTIVITY_LIMIT = 5;

/** The last point that carries a number; null = the metric was never measured. */
export function latestValue(series: MetricSeries | undefined): number | null {
  const points = (series?.points ?? []).filter((p) => p.value !== null);
  return points.length === 0 ? null : (points[points.length - 1]!.value as number);
}

/** Ratio metrics are stored 0..1 (METRICS.md); charts with a % axis must scale. */
export function scaleForUnit(value: number, unit: string): number {
  return unit === '%' ? value * 100 : value;
}

/**
 * Group hotspot paths into a treemap: one node per top-level directory.
 *
 * W20-12 (UX_TODO DSH-21): AREA is churn (lines changed) and colour is the
 * score, as the spec draws it. Both encoded the score before, so the map said
 * one thing twice. `score` rides on each leaf for the colour; a payload with
 * no decomposition falls back to sizing by score.
 */
export function toTreemap(items: RepoHotspots['items']): {
  name: string;
  value: number;
  children: { name: string; value: number; score: number; path: string }[];
}[] {
  const dirs = new Map<string, { name: string; value: number; score: number; path: string }[]>();
  for (const item of items) {
    const segments = item.path.split('/');
    // Files at the repo root have no directory — group them under '/' rather
    // than dropping them, which would silently shrink the treemap's total.
    const dir = segments.length > 1 ? segments[0]! : '/';
    const leaf = {
      name: segments[segments.length - 1]!,
      value: item.decomposition?.gross ?? item.hotspot_score,
      score: item.hotspot_score,
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

/** GET /repos/{id}/ci — M9's three components (W4-15, METRICS.md §1). */
export interface RepoCi {
  window: string;
  computed_at: string | null;
  /** Default-branch only. null = no completed runs to divide by, NOT zero. */
  pass_rate: number | null;
  pr_pass_rate: number | null;
  default_branch_runs: number | null;
  pr_runs: number | null;
  duration: { medianMs: number | null; p90Ms: number | null } | null;
  flakiest: {
    workflow: string;
    /** null = never rerun, which is not a flakiness of 0. */
    flakiness: number | null;
    rerun_groups: number;
    flipped_groups: number;
  }[];
  flakiness_workflows: number | null;
  /**
   * False when the newest snapshot predates W4-15 — distinct from "this repo
   * has no CI", which would otherwise render identically.
   */
  components_available: boolean;
}

/** GET /repos/{id}/review-load — per-reviewer counts (W4-15, UX_SPEC §4.b). */
export interface RepoReviewLoad {
  window: string;
  items: {
    login: string;
    prs_reviewed: number;
    reviews: number;
    approvals: number;
    changes_requested: number;
    comments: number;
  }[];
  prs_with_review: number;
  excluded: { self_reviews: number; bot_reviews: number };
}

/** A ratio with its parts (METRICS.md §0): value null = empty denominator, "no data". */
export interface RatioParts {
  value: number | null;
  numerator: number;
  denominator: number;
}

/**
 * GET /repos/{id}/review-bots — the AI reviewers a team runs (W18-23,
 * METRICS.md §5). Per TOOL, never per person; bots arrive in a fixed registry
 * order and the screen keeps it (no ranking, N-9).
 */
export interface RepoReviewBots {
  window: string;
  forge: 'github' | 'gitea' | 'gitlab' | null;
  /** Why comment-based columns may be blank — each case is a different fact. */
  line_data: 'available' | 'refused' | 'not_collected';
  prs_in_window: number;
  prs_with_line_data: number;
  other_bot_reviews: number;
  bots: {
    key: string;
    name: string;
    logins_seen: string[];
    prs_reviewed: number;
    reach: RatioParts;
    reviews: number;
    reviews_per_pr: RatioParts;
    prs_with_line_data: number;
    inline_comments: number | null;
    comments_per_pr: RatioParts | null;
    time_to_first: { median_hours: number | null; p90_hours: number | null; n: number };
    followed_by_change: (RatioParts & { pending: number }) | null;
    repeat_after_dismiss: (RatioParts & { dismissed_without_inline: number }) | null;
  }[];
}
