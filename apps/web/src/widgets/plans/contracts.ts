// Plans wire contracts (W5-07). Source of truth is apps/api/src/routes/plans.

export type PlanItemStatus =
  | 'proposed'
  | 'accepted'
  | 'in_progress'
  | 'done'
  | 'regressed'
  | 'dismissed';

export interface PlanItem {
  id: number;
  rank: number;
  catalog_id: string;
  source: string;
  recommendation: string;
  effort: 'S' | 'M' | 'L';
  status: PlanItemStatus;
  evidence: Record<string, unknown>;
  verify_criterion: { metricKey: string; op: 'gte' | 'lte'; target: number; windowDays: number; dimPath?: string[] };
  verified_at: string | null;
}

export interface Plan {
  id: number;
  window: string;
  repo_ids: number[];
  catalog_version: string;
  status: string;
  created_at: string;
  items: PlanItem[];
}

/**
 * The verify criterion in words.
 *
 * The stored form is machine-readable ({metricKey, op, target, windowDays}) and
 * unreadable on a card. Rendering the raw JSON would technically be honest and
 * practically useless — someone deciding whether to accept an item needs to
 * know what "done" will mean before they commit to it.
 */
/** Metric id → human name, from `/metrics/catalog`. */
export type MetricNames = Record<string, string>;

/**
 * `M6` is not a sentence anyone can act on (W16-53).
 *
 * The plan's exit criterion and evidence line printed raw metric ids — "Closes
 * automatically when M6 stays at most 0.05" — on a screen whose whole job is
 * getting a person to agree to a piece of work. The catalog exists precisely so
 * a screen can name a metric instead of numbering it, and the route that serves
 * it says so; nothing had ever fetched it.
 *
 * `names` is optional and the id is the fallback, because a criterion is still
 * better shown with an unresolved key than not shown while a request is in
 * flight.
 */
export function metricInWords(key: string, names?: MetricNames): string {
  const name = names?.[key];
  // The id travels WITH the name rather than being replaced by it: it is what
  // the metric catalog, the reports and the API all call this thing, so a
  // reader who wants to look it up still can.
  return name ? `${name} (${key})` : key;
}

export function criterionInWords(
  c: PlanItem['verify_criterion'],
  names?: MetricNames,
): string {
  const direction = c.op === 'gte' ? 'at least' : 'at most';
  const metric = metricInWords(c.metricKey, names);
  const what = c.dimPath?.length ? `${metric} ${c.dimPath.join(' ')}` : metric;
  return `Closes automatically when ${what} stays ${direction} ${c.target} for ${c.windowDays} days.`;
}

/** Progress counts only what a human accepted — proposed work is not progress. */
export function planProgress(plan: Plan): { done: number; total: number; regressed: number } {
  const tracked = plan.items.filter((i) => i.status !== 'dismissed' && i.status !== 'proposed');
  return {
    done: tracked.filter((i) => i.status === 'done').length,
    total: tracked.length,
    regressed: plan.items.filter((i) => i.status === 'regressed').length,
  };
}

// ---------------------------------------------------------------------------
// Scope (W17-24). A plan is generated FOR a set of repositories (empty = the
// whole workspace) and keeps that scope. Everything that names a scope on
// screen goes through these, so a label can never claim more or less than the
// row records.

export interface GenerateRequest {
  window: string;
  repo_ids: number[];
}

/** POST /plans answer. `reused` = an identical plan already existed; no row written. */
export interface GenerateResult {
  id: number;
  item_count: number;
  reused: boolean;
  repo_ids: number[];
  window: string;
}

/** Repo id → "org/name", from `/repos`. */
export type RepoNames = Record<number, string>;

/** The topbar's `?repos=` CSV (or `all`) as sorted, de-duplicated ids. */
export function repoIdsFromFilter(repos: string | undefined | null): number[] {
  if (!repos || repos === 'all') return [];
  const ids = repos
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** Same repositories, regardless of order or repetition. */
export function sameScope(a: readonly number[], b: readonly number[]): boolean {
  const left = [...new Set(a)].sort((x, y) => x - y);
  const right = [...new Set(b)].sort((x, y) => x - y);
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/**
 * The scope in words. Names when every repository is known; a COUNT when any
 * is not — "3 repositories" is true where "acme/api, #77" would be a guess.
 */
export function planScopeLabel(repoIds: readonly number[], names?: RepoNames): string {
  const ids = [...new Set(repoIds)].sort((a, b) => a - b);
  if (ids.length === 0) return 'the whole workspace';
  const named = ids.map((id) => names?.[id]);
  if (named.every((n): n is string => typeof n === 'string' && n.length > 0)) {
    return named.join(', ');
  }
  return ids.length === 1 ? '1 repository' : `${ids.length} repositories`;
}

/** The URL search that scopes the Plans page to one repository. */
export function planSearchForRepo(repoId: number): { repos: string } {
  return { repos: String(repoId) };
}

/**
 * The findings an item is about, when the generator recorded them. Only the
 * finding-sourced catalog entries do (their evidence carries the ids the
 * FINDINGS snapshot clustered); a metric item has none and gets none — the
 * link is drawn from what the row holds, never inferred.
 */
export function findingIdsOf(item: Pick<PlanItem, 'evidence'>): number[] {
  const raw = item.evidence.findingIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
}
