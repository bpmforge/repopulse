import type { ForgeCursor } from '../types.js';

// Gitea pagination (FORGE_PROVIDER §5). Unlike GitHub, which hands back an
// opaque `Link` header, Gitea takes `page`/`limit` and reports the full result
// size in `x-total-count`. So the cursor here IS the page number, and the total
// is what lets INGESTION §7 report a TRUE percent-complete rather than the
// "pages seen so far" estimate GitHub forces.

/** Gitea's MAX_RESPONSE_ITEMS default. Asking for more is silently clamped. */
export const GITEA_MAX_PER_PAGE = 50;

/**
 * Next page cursor, or undefined on the last page.
 *
 * Derived from x-total-count rather than "did we get a full page", because a
 * full final page is indistinguishable from a full middle page — that guess
 * costs one wasted request per entity per backfill, and worse, an empty final
 * response would set backfill_done on a repo that still had rows.
 */
export function nextPageCursor(
  currentPage: number,
  received: number,
  perPage: number,
  totalCount: number | null,
): ForgeCursor | undefined {
  if (received === 0) return undefined;
  if (totalCount !== null) {
    const seen = (currentPage - 1) * perPage + received;
    return seen < totalCount ? String(currentPage + 1) : undefined;
  }
  // No x-total-count (older Gitea, or an endpoint that omits it): fall back to
  // the full-page heuristic and accept one extra request at the end.
  return received >= perPage ? String(currentPage + 1) : undefined;
}

/** `x-total-count` as a number, or null when absent/unparseable. */
export function totalCountOf(headers: Record<string, string>): number | null {
  const raw = headers['x-total-count'] ?? headers['X-Total-Count'];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Cursor → page number. Absent/garbage means page 1, never NaN. */
export function pageOfCursor(cursor?: ForgeCursor): number {
  if (!cursor) return 1;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Append page/limit to a Gitea URL. */
export function withPage(base: string, page: number, perPage: number): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}page=${page}&limit=${perPage}`;
}
