import { describe, expect, it } from 'vitest';
import { parseGithubRateLimitHeaders, parseRetryAfterSeconds } from './rate-limit-headers.js';

describe('parseGithubRateLimitHeaders', () => {
  it('parses real GitHub header shapes (research §1)', () => {
    const parsed = parseGithubRateLimitHeaders({
      'x-ratelimit-remaining': '4987',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': '1700000000',
    });
    expect(parsed).toEqual({ remaining: 4987, limit: 5000, resetAt: 1_700_000_000_000 });
  });

  it('is case-insensitive', () => {
    const parsed = parseGithubRateLimitHeaders({ 'X-RateLimit-Remaining': '10' });
    expect(parsed.remaining).toBe(10);
  });

  it('leaves fields undefined when headers are absent - never guessed', () => {
    expect(parseGithubRateLimitHeaders({})).toEqual({
      remaining: undefined,
      limit: undefined,
      resetAt: undefined,
    });
  });
});

describe('parseRetryAfterSeconds', () => {
  it('parses retry-after', () => {
    expect(parseRetryAfterSeconds({ 'retry-after': '30' })).toBe(30);
  });

  it('returns undefined when absent', () => {
    expect(parseRetryAfterSeconds({})).toBeUndefined();
  });
});
