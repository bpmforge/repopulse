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
  tiles: {
    metric_key: string;
    value: number | null;
    delta: number | null;
    /** The baseline the delta is against — a percent change needs it (W16-56). */
    previous: number | null;
  }[];
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

/**
 * GET /org/top-actions — at most three things worth doing next (W17-16).
 *
 * Mirrors `serializeTopActions` in apps/api/src/routes/org/top-actions.ts
 * field-for-field. The route takes NO querystring: `collectTopActions` is
 * window-independent, because "what should we do next" is a question about the
 * current state of the warehouse rather than about a reporting period.
 */
export interface TopActionsResponse {
  actions: TopActionItem[];
  /**
   * Present ONLY when `actions` is empty, and the whole reason an empty card is
   * not a clean bill of health: "we measured nine repositories and nothing is
   * pressing" and "we have never measured anything" must not render the same.
   */
  coverage: TopActionsCoverage | null;
  generated_at: string;
}

export interface TopActionItem {
  id: string;
  kind: 'finding' | 'plan_item';
  title: string;
  reason: string;
  repo_id: number | null;
  repo_name: string | null;
  /** Plan items only — nobody has estimated a finding. */
  effort: string | null;
  target:
    | { kind: 'finding'; finding_id: number; repo_id: number }
    | { kind: 'plan_item'; plan_id: number; plan_item_id: number };
  /** The server's own deep link. The card asserts against it rather than re-deriving it. */
  href: string;
}

export interface TopActionsCoverage {
  basis: 'none' | 'partial' | 'full';
  repos_total: number;
  repos_measured: number;
  repos_never_measured: number;
  repos_stale: number;
  notices: TopActionsNotice[];
  unsupported: string[];
  /** Rendered VERBATIM. Recomputing it here would fork summarizeCoverage. */
  summary: string;
}

export interface TopActionsNotice {
  repo_id: number;
  repo_name: string;
  capability: string;
  /** `failed` (it ran and broke) vs `not_configured` (it never ran). */
  state: string;
  detail: string;
}

/**
 * The repository a cross-repo row belongs to. Same shape the Findings explorer
 * carries (widgets/findings/contracts.ts) so every list names a repository the
 * same way; `org` travels with `name` because two connected orgs may both have
 * a repo called `api`, and the disambiguating half must not be the one dropped.
 */
export interface RepoRef {
  id: number;
  org: string;
  name: string;
}

/**
 * True when these rows come from more than one repository — the only case in
 * which a Repository column earns its width. A repo-scoped list would otherwise
 * grow a column repeating the repo the user already navigated into.
 */
export function spansMultipleRepos(rows: readonly { repo: RepoRef }[]): boolean {
  return new Set(rows.map((r) => r.repo.id)).size > 1;
}

/** GET /hotspots?window=&limit= */
export interface HotspotItems {
  items: { repoId: number; repo: RepoRef; path: string; score: number }[];
  /**
   * W6-09. Acknowledged files are hidden from the LIST, never from the data —
   * so the count travels with it. A leaderboard that omits rows without saying
   * so is worse than one that shows everything: the first person to notice
   * stops trusting every other number on the screen.
   */
  suppressed_count?: number;
  suppressed_paths?: string[];
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
  /** W4-10 (UX_SPEC §6). null = never asked, which is what opens the picker. */
  persona?: Persona | null;
  prefs?: UserPrefs;
  /**
   * W13-02. True when the API is serving a fake forge and a mocked login.
   * Comes from the server because only the server knows what it is connected
   * to — a browser-side build flag could disagree with the API it is talking
   * to, and the failure mode is a screenshot of fixture data mistaken for a
   * real organisation.
   */
  demo?: boolean;
}

export const PERSONAS = ['lead', 'developer', 'security', 'exec'] as const;
export type Persona = (typeof PERSONAS)[number];

export interface UserPrefs {
  /** Onboarding checklist dismissal (R-A1). Absent = never dismissed. */
  onboardingDismissed?: boolean;
}

/**
 * The percent change a KPI tile shows (W16-56).
 *
 * The tile was handed `trend.delta` — an ABSOLUTE change — for a prop called
 * `deltaPct`, so commit churn falling by 373 lines rendered as "▼373%": a drop
 * of nearly four times everything there was. Every non-ratio tile was wrong in
 * the same way, and the two ratio tiles looked right only by coincidence.
 *
 * Null when there is no baseline to divide by, INCLUDING a previous value of
 * zero: the change from nothing to something is not a percentage, and the tile
 * already has honest words for an absent delta.
 */
export function deltaPctOf(delta: number | null, previous: number | null): number | null {
  if (delta === null || previous === null || previous === 0) return null;
  return (delta / Math.abs(previous)) * 100;
}
