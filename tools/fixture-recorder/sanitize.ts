// Secret-scrubbing for recorded GitHub fixtures (W0-04 acceptance: "all
// tokens scrubbed"). Applied to every response before it touches disk. The
// request Authorization header is never captured in the first place.

// Response headers we keep — everything the BudgetedClient/ETag layer reads,
// nothing that identifies our token or carries a session. x-ratelimit-* and
// etag are retained on purpose (acceptance requires them).
const KEEP_HEADERS = new Set([
  'etag',
  'last-modified',
  'content-type',
  'link', // pagination cursors (FR-FORGE) — must survive
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-used',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-github-media-type',
  'x-github-request-id',
  'status',
]);

// Token shapes (github-api.md): PAT classic ghp_, fine-grained github_pat_,
// OAuth gho_, App user-to-server ghu_, server-to-server ghs_, refresh ghr_.
const TOKEN_PATTERN = /\b(gh[opusr]|github_pat)_[A-Za-z0-9_]{20,}\b/g;

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (KEEP_HEADERS.has(key)) out[key] = scrubString(value);
  }
  return out;
}

export function scrubString(value: string): string {
  return value.replace(TOKEN_PATTERN, 'REDACTED-TOKEN');
}

/** Deep-scrub token-shaped substrings from any JSON body (recursively). */
export function scrubBody(body: unknown): unknown {
  if (typeof body === 'string') return scrubString(body);
  if (Array.isArray(body)) return body.map(scrubBody);
  if (body && typeof body === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) out[k] = scrubBody(v);
    return out;
  }
  return body;
}
