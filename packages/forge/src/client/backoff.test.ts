import { describe, expect, it } from 'vitest';
import { secondaryLimitBackoffMs, serverErrorBackoffMs } from './backoff.js';

describe('secondaryLimitBackoffMs (§3 retry policy)', () => {
  it('honors retry-after first', () => {
    expect(
      secondaryLimitBackoffMs({ retryAfterSeconds: 30, rateLimitResetAt: 999_999_999_999 }, 0, 0),
    ).toBe(30_000);
  });

  it('falls back to x-ratelimit-reset when retry-after is absent', () => {
    expect(secondaryLimitBackoffMs({ rateLimitResetAt: 5000 }, 0, 1000)).toBe(4000);
  });

  it('falls back to >=60s exponential backoff when neither header is present', () => {
    expect(secondaryLimitBackoffMs({}, 0, 0)).toBeGreaterThanOrEqual(60_000);
    expect(secondaryLimitBackoffMs({}, 7, 0)).toBeGreaterThan(60_000); // 2^7*1000 = 128s > floor
  });
});

describe('serverErrorBackoffMs (5xx: 3 retries, jittered)', () => {
  it('grows with attempt number and includes jitter', () => {
    const noJitter = serverErrorBackoffMs(1, 0);
    const fullJitter = serverErrorBackoffMs(1, 1);
    expect(fullJitter).toBeGreaterThan(noJitter);
    expect(serverErrorBackoffMs(2, 0)).toBeGreaterThan(serverErrorBackoffMs(1, 0));
  });
});
