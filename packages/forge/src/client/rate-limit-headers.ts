// GitHub's real header shapes (research §1) - headers are case-normalized to
// lowercase by both undici/fetch and Node's http, so callers may pass either case.
export interface ParsedRateLimitHeaders {
  remaining?: number | undefined;
  limit?: number | undefined;
  resetAt?: number | undefined; // epoch ms
}

function get(headers: Record<string, string>, name: string): string | undefined {
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

export function parseGithubRateLimitHeaders(
  headers: Record<string, string>,
): ParsedRateLimitHeaders {
  const remaining = get(headers, 'x-ratelimit-remaining');
  const limit = get(headers, 'x-ratelimit-limit');
  const reset = get(headers, 'x-ratelimit-reset');
  return {
    remaining: remaining !== undefined ? Number(remaining) : undefined,
    limit: limit !== undefined ? Number(limit) : undefined,
    resetAt: reset !== undefined ? Number(reset) * 1000 : undefined,
  };
}

export function parseRetryAfterSeconds(headers: Record<string, string>): number | undefined {
  const v = get(headers, 'retry-after');
  return v !== undefined ? Number(v) : undefined;
}
