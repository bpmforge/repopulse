import { and, asc, desc, eq, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { core, read } from '@repopulse/shared';

// SORT BY ANY COLUMN, EITHER WAY (W26-05).
//
// The two orders the list always had keep their own cursors (W17-32): risk,
// highest first (the default), and severity, highest first. Every other
// (column, direction) pair is a "general" sort: ORDER BY one key expression
// and then id, both in the same direction, with a cursor that carries the
// key's own text as Postgres rendered it, so the "after this row" predicate
// compares exactly what was ordered by. A key is never NULL (file is
// coalesced to ''), except risk, whose unpriced rows stay last both ways: an
// unpriced finding has not been judged low-risk, it has not been judged.

export const SORT_KEYS = [
  'risk',
  'severity',
  'title',
  'repository',
  'file',
  'status',
  'first_seen',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

/** The direction a column sorts in when the request names none. */
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  risk: 'desc',
  severity: 'desc',
  title: 'asc',
  repository: 'asc',
  file: 'asc',
  status: 'asc',
  first_seen: 'asc',
};

export interface ListSort {
  key: SortKey;
  dir: SortDir;
}

/** Anything unknown falls back to the default sort, as before W26-05. */
export function parseSort(sort: string | undefined, dir: string | undefined): ListSort {
  const key: SortKey = (SORT_KEYS as readonly string[]).includes(sort ?? '')
    ? (sort as SortKey)
    : 'risk';
  const d: SortDir = dir === 'asc' || dir === 'desc' ? dir : DEFAULT_DIR[key];
  return { key, dir: d };
}

/** The two orders that keep their W17-32 cursors. */
export function isLegacy(s: ListSort): s is { key: 'risk' | 'severity'; dir: 'desc' } {
  return (s.key === 'risk' || s.key === 'severity') && s.dir === 'desc';
}

/** Lifecycle order: still to fix first, closed without a fix last. */
const STATUS_RANK = sql`(case ${read.findings.status}
  when 'open' then 0 when 'confirmed' then 1 when 'resolved' then 2
  when 'wont_fix' then 3 when 'dismissed' then 4 else 9 end)`;

type Cast = 'int' | 'text' | 'timestamptz' | 'numeric';

function keyOf(key: SortKey): { expr: SQL; cast: Cast } {
  switch (key) {
    case 'severity':
      return { expr: sql`${read.findings.severity}`, cast: 'int' };
    case 'title':
      return { expr: sql`lower(${read.findings.title})`, cast: 'text' };
    case 'repository':
      return { expr: sql`lower(${core.repos.org} || '/' || ${core.repos.name})`, cast: 'text' };
    case 'file':
      return { expr: sql`coalesce(${read.findings.file}, '')`, cast: 'text' };
    case 'status':
      return { expr: STATUS_RANK, cast: 'int' };
    case 'first_seen':
      // Milliseconds: what survives the round trip through the cursor text.
      return {
        expr: sql`date_trunc('milliseconds', ${read.findings.firstSeenAt})`,
        cast: 'timestamptz',
      };
    case 'risk':
      return { expr: sql`${read.findings.effectiveRisk}`, cast: 'numeric' };
  }
}

/** The key as text, selected with the row so the cursor can carry it. */
export function sortKeyText(s: ListSort): SQL {
  return sql`(${keyOf(s.key).expr})::text`;
}

export function orderFor(s: ListSort): SQL[] {
  if (s.key === 'severity' && s.dir === 'desc') {
    return [desc(read.findings.severity), desc(read.findings.id)];
  }
  if (s.key === 'risk') {
    return s.dir === 'desc'
      ? [
          sql`${read.findings.effectiveRisk} desc nulls last`,
          desc(read.findings.severity),
          desc(read.findings.id),
        ]
      : [sql`${read.findings.effectiveRisk} asc nulls last`, asc(read.findings.id)];
  }
  const { expr } = keyOf(s.key);
  return s.dir === 'asc'
    ? [sql`${expr} asc`, asc(read.findings.id)]
    : [sql`${expr} desc`, desc(read.findings.id)];
}

export interface GeneralCursor {
  sort: 'general';
  key: SortKey;
  dir: SortDir;
  /** The key as Postgres rendered it; null only for an unpriced risk. */
  value: string | null;
  id: number;
}

export function encodeGeneral(s: ListSort, value: string | null, id: number): string {
  const v = value === null ? '-' : Buffer.from(value).toString('base64url');
  return Buffer.from(`g:${s.key}:${s.dir}:${v}:${id}`).toString('base64url');
}

export function decodeGeneral(parts: string[]): GeneralCursor | null {
  if (parts[0] !== 'g' || parts.length !== 5) return null;
  const [, key, dir, v, idText] = parts;
  if (!(SORT_KEYS as readonly string[]).includes(key ?? '')) return null;
  if (dir !== 'asc' && dir !== 'desc') return null;
  const id = Number(idText);
  if (!Number.isInteger(id)) return null;
  let value: string | null;
  if (v === '-') {
    if (key !== 'risk') return null;
    value = null;
  } else {
    value = Buffer.from(v ?? '', 'base64url').toString('utf8');
  }
  return { sort: 'general', key: key as SortKey, dir, value, id };
}

/** Rows strictly after the cursor row, in the order orderFor() gives. */
export function afterGeneral(c: GeneralCursor): SQL {
  const { expr, cast } = keyOf(c.key);
  const idAfter = c.dir === 'asc' ? gt(read.findings.id, c.id) : lt(read.findings.id, c.id);
  if (c.key === 'risk') {
    // Only reached for risk ascending (descending keeps its W17-32 cursor).
    if (c.value === null) return and(isNull(read.findings.effectiveRisk), idAfter)!;
    const k = sql`${c.value}::numeric`;
    return or(
      sql`${read.findings.effectiveRisk} > ${k}`,
      and(eq(read.findings.effectiveRisk, c.value), idAfter),
      isNull(read.findings.effectiveRisk),
    )!;
  }
  const k = sql.raw(`::${cast}`);
  const beyond = c.dir === 'asc' ? sql`${expr} > ${c.value}${k}` : sql`${expr} < ${c.value}${k}`;
  return or(beyond, and(sql`${expr} = ${c.value}${k}`, idAfter))!;
}
