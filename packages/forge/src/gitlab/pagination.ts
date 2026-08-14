import type { ForgeCursor } from '../types.js';

// GitLab offset pagination (verified live against gitlab.com/api/v4, 2026-08-14).
//
// GitLab is the most informative of the three forges here: it returns
// `x-next-page` (empty string on the last page), `x-page`, `x-total` and
// `x-total-pages`. So unlike Gitea we do not have to derive the next page from
// a running count, and unlike GitHub we do not have to parse a Link header —
// the server states it outright.

/** GitLab's documented maximum; larger values are clamped server-side. */
export const GITLAB_MAX_PER_PAGE = 100;

/** `x-next-page` verbatim. Empty means this was the last page. */
export function nextPageCursor(headers: Record<string, string>): ForgeCursor | undefined {
  const raw = headers['x-next-page'] ?? headers['X-Next-Page'];
  if (raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `x-total` — exact result count, so percent-complete is real (INGESTION §7). */
export function totalCountOf(headers: Record<string, string>): number | null {
  const raw = headers['x-total'] ?? headers['X-Total'];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function pageOfCursor(cursor?: ForgeCursor): number {
  if (!cursor) return 1;
  const n = Number(cursor);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function withPage(base: string, page: number, perPage: number): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}page=${page}&per_page=${perPage}`;
}

/**
 * A GitLab project id is `namespace/project` and MUST be URL-encoded into the
 * path — `gitlab-org%2Fcli`, not `gitlab-org/cli`. Sending it raw silently
 * routes to a different endpoint and 404s, which reads like a permissions
 * problem rather than a formatting one.
 */
export function projectPath(fullName: string): string {
  return encodeURIComponent(fullName);
}
