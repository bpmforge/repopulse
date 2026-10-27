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
    /** W20-12 (UX_TODO DSH-81): the ratio's parts; null/absent for non-ratios. */
    sample?: { numerator: number; denominator: number } | null;
  }[];
  /** W20-12 (UX_TODO DSH-48): the newest snapshot in scope; null = none yet. */
  as_of?: string | null;
  /** W20-20 (UX_TODO DSH-56): present when the tiles were computed for a custom range. */
  range?: { from: string; to: string; days: number };
}

/**
 * "Data as of 19 Oct, 02:10" (W20-12, UX_TODO DSH-48) — the freshness stamp a
 * lead needs to tell last night's numbers from this morning's. Local time,
 * because that is the clock the reader knows the nightly run by.
 */
export function asOfLabel(iso: string | null | undefined): string {
  if (!iso) return 'No metrics computed yet';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'No metrics computed yet';
  return `Data as of ${at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * GET /org/health-tiles?window=&repos= — worst first, unmeasured last (W20-05).
 *
 * `score` is null when nothing was measured (UX_TODO DSH-08): the empty-set 0
 * the API used to send painted an un-ingested repository red.
 */
export interface HealthTiles {
  items: {
    id: number;
    org: string;
    name: string;
    health: {
      score: number | null;
      letter: string | null;
      measured: boolean;
      basis: string;
      /** W20-12 (UX_TODO DSH-19): the sub-score keys not measured. Older API: absent. */
      not_measured?: string[];
      delta: number | null;
    };
  }[];
}

/**
 * GET /org/attention?window=&repos= — measured repositories below the healthy
 * band, banded by the SAME function as the health badge (W20-05, DSH-10).
 */
export interface AttentionItems {
  items: {
    repo_id: number;
    org: string;
    name: string;
    kind: string;
    band: 'watch' | 'attend';
    score: number;
  }[];
  /**
   * W20-24 (UX_TODO DSH-37): file intents whose promise lapsed. Absent on an
   * older API.
   */
  intents?: IntentAttentionItem[];
}

/** A refactor whose hotspot has not come down, or a supervised file that got hotter. */
export interface IntentAttentionItem {
  kind: 'refactor_stalled' | 'supervised_decline';
  repo_id: number;
  org: string;
  name: string;
  path: string;
  intent: string;
  /** When the intent was declared. */
  since: string;
  /** Hotspot score at the declaration and now. */
  from: number;
  to: number;
  months?: number;
}

/** The sentence an intent warning reads as (W20-24, DSH-37). */
export function intentWarningText(i: IntentAttentionItem): string {
  const day = i.since.slice(0, 10);
  const scores = `hotspot ${i.from.toFixed(2)} → ${i.to.toFixed(2)}`;
  if (i.kind === 'refactor_stalled') {
    const m = i.months ?? 0;
    return `Refactor since ${day}: no improvement in ${m} month${m === 1 ? '' : 's'} (${scores})`;
  }
  return `Supervised since ${day}: hotspot rising (${scores})`;
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
  /** W20-20 (UX_TODO DSH-91): every repository in scope; repos_total = inspected. */
  repos_in_scope?: number;
  notices: TopActionsNotice[];
  unsupported: string[];
  /** Rendered VERBATIM. Recomputing it here would fork summarizeCoverage. */
  summary: string;
}

export interface TopActionsNotice {
  repo_id: number;
  repo_name: string;
  capability: string;
  /** W20-20 (UX_TODO DSH-91): plain name, and `ai_review` / `scanner` / `metadata`. */
  label?: string;
  kind?: string;
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
  items: {
    repoId: number;
    repo: RepoRef;
    path: string;
    score: number;
    /** M2's parts, sent all along (W20-12, DSH-20/79). Optional: older API. */
    gross?: number;
    daysSince?: number;
  }[];
  /**
   * W6-09. Acknowledged files are hidden from the LIST, never from the data —
   * so the count travels with it. A leaderboard that omits rows without saying
   * so is worse than one that shows everything: the first person to notice
   * stops trusting every other number on the screen.
   */
  suppressed_count?: number;
  suppressed_paths?: string[];
  /** W20-20 (UX_TODO DSH-70): each hidden file with its repository. */
  suppressed?: { repo_id: number; org: string; name: string; path: string }[];
}

/** GET /metrics/series?metric_key=&window= — oldest-first. */
export interface MetricSeries {
  points: {
    computed_at: string;
    value: number | null;
    /** A ratio's parts (W20-12, DSH-81); null for a non-ratio metric. */
    numerator?: number | null;
    denominator?: number | null;
  }[];
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
  /**
   * W20-04 (UX_TODO ADM-11). The signed-in user's own id, so Members can warn
   * before an admin demotes themselves. Optional: an older API omits it.
   */
  user_id?: number;
  /** W20-17 (UX_TODO ADM-54): the signed-in account, for the user menu. */
  login?: string | null;
  email?: string | null;
  /** W20-17: repositories tracked in this workspace (first-run surfaces). */
  repo_count?: number;
  /** W20-17 (UX_TODO INS-39): repositories already live, and workspace members. */
  live_repo_count?: number;
  member_count?: number;
  /** Completed security / code-health scans, and configured models (onboarding). */
  succeeded_scan_count?: number;
  model_count?: number;
  /** W20-17 (UX_TODO ADM-21): up to five admin logins, sent to members only. */
  admin_logins?: string[];
  identity_id: number | null;
  default_view_id: number | null;
  /**
   * The persona's home path (W20-05, UX_TODO DSH-03), from the API's own
   * PERSONA_HOME. null until a persona is chosen.
   */
  home?: string | null;
  /** W4-10 (UX_SPEC §6). null = never asked, which is what opens the picker. */
  persona?: Persona | null;
  prefs?: UserPrefs;
  /**
   * W13-02. True when the API is serving a fake forge and a mocked login.
   * Comes from the server because only the server knows what it is connected
   * to — a browser-side build flag could disagree with the API it is talking
   * to, and the failure mode is a screenshot of fixture data mistaken for a
   * real organization.
   */
  demo?: boolean;
  /**
   * W20-07 (UX_TODO INS-74). False on an install where nobody is admin yet — a
   * federated sign-in no longer makes itself admin — so a member is told what
   * the operator has to set instead of "ask an admin". Optional: older API.
   */
  has_admin?: boolean;
}

export const PERSONAS = ['lead', 'developer', 'security', 'exec', 'admin'] as const;
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

/** Below this many items a ratio is marked "small sample" (W20-12, UX_TODO DSH-81). */
export const SMALL_SAMPLE = 5;

/**
 * The change a KPI tile shows, and in what (W20-12, UX_TODO DSH-17/83).
 *
 * - A percentage metric changes in POINTS: review coverage 40% → 45% is
 *   "+5 pts", where a relative "+12.5%" read as the coverage itself rising
 *   by 12.5.
 * - From a zero baseline there is no percentage, but there IS a change: "+5
 *   from 0" rather than "no prior window", which was false — the window
 *   existed and measured zero.
 * - Otherwise the relative percent change, as before.
 */
export function deltaOf(
  delta: number | null,
  previous: number | null,
  unit: string | undefined,
): { value: number | null; kind: 'pct' | 'pts' | 'abs' } {
  if (delta === null || previous === null) return { value: null, kind: 'pct' };
  if (unit === '%') return { value: delta * 100, kind: 'pts' };
  if (previous === 0) return { value: delta, kind: 'abs' };
  return { value: deltaPctOf(delta, previous), kind: 'pct' };
}

/**
 * The change in words for a label (W20-20, UX_TODO DSH-55): "up 5.0 pts",
 * "down 12%", "up 5 from 0"; null when nothing was compared.
 */
export function changeText(d: {
  value: number | null;
  kind: 'pct' | 'pts' | 'abs';
}): string | null {
  if (d.value === null) return null;
  if (d.value === 0) return 'no change';
  const dir = d.value > 0 ? 'up' : 'down';
  const mag = Math.abs(d.value);
  if (d.kind === 'pts') return `${dir} ${mag.toFixed(1)} pts`;
  if (d.kind === 'abs') return `${dir} ${Number.isInteger(mag) ? mag : mag.toFixed(1)} from 0`;
  return `${dir} ${Math.round(mag)}%`;
}

/** GET /org/ai-governance (W18-20). Aggregate only — no logins, no trailer values. */
export interface AiGovernanceMeasure {
  key: 'findings_per_kloc' | 'rework_14d' | 'revert_rate' | 'review_coverage' | 'reviews_per_pr';
  label: string;
  basis: string;
  unit: 'ratio' | 'per_kloc' | 'count';
  ai: number | null;
  human: number | null;
  aiSample: number;
  humanSample: number;
  sampleUnit: string;
  comparable: boolean;
  direction: 'higher' | 'lower' | 'similar' | null;
  note: string | null;
}

export interface AiGovernance {
  window: string;
  aiShareCommits: number | null;
  aiSharePrs: number | null;
  counts: {
    aiCommits: number;
    humanCommits: number;
    aiPrs: number;
    humanPrs: number;
    automationCommits: number;
    automationPrs: number;
    unknownCommits: number;
    unknownPrs: number;
  };
  measures: AiGovernanceMeasure[];
  anyComparable: boolean;
  findingsMeasured: boolean;
  unattributedFindings: number;
  patternsFingerprint: string;
  repoCount: number;
}
