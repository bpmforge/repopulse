// Pure backoff math (FORGE_PROVIDER.md §3 retry policy) - kept free of
// timers/randomness sources so it's directly unit-testable.

export interface SecondaryLimitHeaders {
  retryAfterSeconds?: number | undefined;
  rateLimitResetAt?: number | undefined; // epoch ms
}

/** Secondary 403/429: retry-after, else x-ratelimit-reset, else >=60s exponential. */
export function secondaryLimitBackoffMs(
  headers: SecondaryLimitHeaders,
  attempt: number,
  now: number,
): number {
  if (typeof headers.retryAfterSeconds === 'number') {
    return Math.max(0, headers.retryAfterSeconds * 1000);
  }
  if (typeof headers.rateLimitResetAt === 'number') {
    return Math.max(0, headers.rateLimitResetAt - now);
  }
  return Math.max(60_000, 2 ** attempt * 1000);
}

/** 5xx: 3 retries, jittered. */
export function serverErrorBackoffMs(attempt: number, jitter: number): number {
  const base = 2 ** attempt * 100;
  return base + jitter * base;
}
