// Token owner and expiry parsing (W20-25, UX_TODO ADM-50). Pure functions, so
// every format a forge sends is unit-tested without a client.

/**
 * GitHub's `GitHub-Authentication-Token-Expiration` response header, sent on
 * an API answer made with a token that expires (changelog 2021-07-26,
 * "Expiration options for personal access tokens"). Seen as
 * `2026-11-30 12:00:00 UTC` and `2026-11-30 12:00:00 +0000`; an ISO timestamp
 * is accepted too. Null for a missing or unreadable value: an expiry we cannot
 * read is not a date to warn about.
 */
export function parseGithubTokenExpiration(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?$/i.exec(
      value.trim(),
    );
  if (!m) return null;
  const zone = m[3];
  let offset = 'Z';
  if (zone && /^[+-]/.test(zone)) {
    offset = zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  }
  const at = new Date(`${m[1]}T${m[2]}${offset}`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * GitLab's `expires_at` on a personal access token: a calendar date
 * (`YYYY-MM-DD`), or null for a token that never expires. Read as the start
 * of that day in UTC, the earliest moment the token may stop working.
 */
export function parseGitlabTokenExpiry(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** A login from a `/user` body (`login` on GitHub and Gitea, `username` on GitLab). */
export function loginOf(body: unknown, field: 'login' | 'username'): string | null {
  if (!body || typeof body !== 'object') return null;
  const v = (body as Record<string, unknown>)[field];
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null;
}

/** A response header by name, whatever case the executor stored it in. */
export function headerOf(headers: Record<string, string>, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return null;
}
