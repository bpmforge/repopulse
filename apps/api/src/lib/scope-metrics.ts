import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { METRIC_CATALOG } from '@repopulse/metrics';
import type { MetricSet } from '@repopulse/insights';

// One metric value for a SET of repositories (W20-09, UX_TODO DSH-86 / DSH-02).
//
// Plan generation, the nightly verifier and the Overview's KPI row all used to
// read "the newest snapshot row per metric" over whatever repositories were in
// scope. For one repository that is right; for several it is the value of
// whichever repository happened to be computed last, so a plan for three
// repositories rested on one of them and a verified item could flip between
// done and regressed depending on job order. This reads EACH repository's own
// latest row and combines them, per METRICS.md §2 / FR-METRICS-14:
//
// - ratio metrics pool numerators and denominators (never a mean of ratios);
// - counts sum (stale PRs, releases, open findings);
// - everything else — percentiles, scores — takes the WORST repository in the
//   metric's own direction. Raw samples are not in the snapshot row, so a
//   pooled p50 cannot be rebuilt here; "worst of the set" is the honest
//   alternative, and it is the reading a plan needs: the item holds when every
//   repository in its scope meets it.
//
// The whole workspace prefers the org rollup row (repo_id NULL) when one exists
// and pools every repository otherwise. The nightly snapshot job writes no org
// rows today (only the seed does), so without the fallback an all-repositories
// scope in production had nothing to read at all.

type Queryable = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

interface Row {
  repoId: number | null;
  metricKey: string;
  value: string;
  numerator: string | null;
  denominator: string | null;
  dims: Record<string, unknown>;
}

/** Metrics whose value is a count over the window: a set's value is the sum. */
const SUMMED = new Set(['M1', 'M8', 'M10', 'M11', 'M12', 'FINDINGS', 'ch_worst_fn_count']);

/** Rates whose parts travel in dims (M13 rework, M14 reverts): pooled from them. */
const POOLED_FROM_DIMS: Record<string, [string, string]> = {
  M13: ['reworkLines', 'totalLines'],
  M14: ['reverts', 'eligibleCommits'],
};

/** Dims where SMALLER is worse — everything else numeric takes the max. */
const MIN_IS_WORST = new Set(['busFactor', 'passRate', 'prPassRate']);

/** Id lists in FINDINGS dims are capped at 50 by the writer; the merge keeps that. */
const ID_LIST_CAP = 50;

function directionOf(key: string): 'higher_better' | 'lower_better' | 'neutral' {
  return METRIC_CATALOG.find((m) => m.id === key)?.direction ?? 'neutral';
}

function numberOr(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Merge one level of dims; recursive for nested objects (M4 stages, M9 duration). */
export function mergeDims(
  all: readonly Record<string, unknown>[],
  summed: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set(all.flatMap((d) => Object.keys(d)));
  for (const key of keys) {
    const values = all.map((d) => d[key]).filter((v) => v !== undefined);
    const numbers = values.map(numberOr).filter((v): v is number => v !== null);
    if (numbers.length > 0 && numbers.length === values.filter((v) => v !== null).length) {
      out[key] = summed
        ? numbers.reduce((s, n) => s + n, 0)
        : MIN_IS_WORST.has(key)
          ? Math.min(...numbers)
          : Math.max(...numbers);
    } else if (values.some(Array.isArray)) {
      const flat = values.filter(Array.isArray).flat();
      const ids = flat.every((v) => typeof v === 'number');
      out[key] = ids ? [...new Set(flat as number[])].slice(0, ID_LIST_CAP) : flat;
    } else if (values.length > 0 && values.every((v) => v !== null && typeof v === 'object')) {
      out[key] = mergeDims(values as Record<string, unknown>[], summed);
    } else {
      // A string label (a DORA basis, a heuristic note) or a null: the first
      // repository's, which is no worse than any other's.
      out[key] = values.find((v) => v !== null) ?? null;
    }
  }
  return out;
}

/** Combine each repository's own row for ONE metric into the set's value. */
export function combineRows(
  key: string,
  rows: readonly Row[],
): { value: number | null; dims: Record<string, unknown> } {
  if (rows.length === 1) {
    const r = rows[0]!;
    return { value: Number(r.value), dims: r.dims ?? {} };
  }
  const summed = SUMMED.has(key);
  const dims = mergeDims(
    rows.map((r) => r.dims ?? {}),
    summed,
  );

  let value: number | null;
  const pooledParts = POOLED_FROM_DIMS[key];
  if (rows.every((r) => r.numerator !== null && r.denominator !== null)) {
    const num = rows.reduce((s, r) => s + Number(r.numerator), 0);
    const den = rows.reduce((s, r) => s + Number(r.denominator), 0);
    value = den > 0 ? num / den : null;
  } else if (pooledParts) {
    const [n, d] = pooledParts;
    const den = rows.reduce((s, r) => s + (numberOr(r.dims?.[d]) ?? 0), 0);
    const num = rows.reduce((s, r) => s + (numberOr(r.dims?.[n]) ?? 0), 0);
    value = den > 0 ? num / den : null;
  } else if (summed) {
    value = rows.reduce((s, r) => s + Number(r.value), 0);
  } else {
    const values = rows.map((r) => Number(r.value));
    value = directionOf(key) === 'higher_better' ? Math.min(...values) : Math.max(...values);
  }
  return { value, dims };
}

export interface ScopedMetricsOptions {
  /**
   * Read as of this moment: each repository's newest row computed at or
   * before it. A KPI's "previous" is the same read one window back.
   */
  asOf?: Date;
  /** Restrict to these metric keys; all keys otherwise. */
  keys?: readonly string[];
}

/**
 * The scope's value for every metric (or `keys`), tenancy-filtered.
 *
 * `repoIds` empty = the whole workspace.
 */
export async function scopedMetrics(
  db: Queryable,
  workspaceId: number,
  repoIds: readonly number[],
  window: string,
  opts: ScopedMetricsOptions = {},
): Promise<MetricSet> {
  const keyFilter = opts.keys ? inArray(read.metricSnapshots.metricKey, [...opts.keys]) : undefined;
  // The newest row per (repository, metric), ONE statement. The rank is
  // over repo_id as well, so a repository computed often cannot crowd one
  // computed rarely out of the set.
  const ranked = db
    .select({
      repoId: read.metricSnapshots.repoId,
      metricKey: read.metricSnapshots.metricKey,
      value: read.metricSnapshots.value,
      numerator: read.metricSnapshots.numerator,
      denominator: read.metricSnapshots.denominator,
      dims: read.metricSnapshots.dims,
      rn: sql<number>`row_number() over (partition by ${read.metricSnapshots.repoId}, ${read.metricSnapshots.metricKey} order by ${read.metricSnapshots.computedAt} desc, ${read.metricSnapshots.id} desc)`.as(
        'rn',
      ),
    })
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, workspaceId),
        eq(read.metricSnapshots.window, window),
        keyFilter,
        opts.asOf ? lte(read.metricSnapshots.computedAt, opts.asOf) : undefined,
        repoIds.length > 0 ? inArray(read.metricSnapshots.repoId, [...repoIds]) : undefined,
      ),
    )
    .as('ranked');
  const rows = (await db.select().from(ranked).where(eq(ranked.rn, 1))) as unknown as Row[];

  const byKey = new Map<string, { org: Row | null; repos: Row[] }>();
  for (const row of rows) {
    const entry = byKey.get(row.metricKey) ?? { org: null, repos: [] };
    if (row.repoId === null) entry.org = row;
    else entry.repos.push(row);
    byKey.set(row.metricKey, entry);
  }

  const set: MetricSet = {};
  for (const [key, entry] of byKey) {
    if (repoIds.length === 0 && entry.org) {
      set[key] = { value: Number(entry.org.value), dims: entry.org.dims ?? {} };
    } else if (entry.repos.length > 0) {
      set[key] = combineRows(key, entry.repos);
    }
  }
  return set;
}
