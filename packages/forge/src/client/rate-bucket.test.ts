import { describe, expect, it } from 'vitest';
import { RateBucket } from './rate-bucket.js';

describe('RateBucket', () => {
  it('starts full and consumes down to zero', () => {
    const bucket = new RateBucket(900, 900, 0);
    expect(bucket.tryConsume(900, 0)).toBe(true);
    expect(bucket.tryConsume(1, 0)).toBe(false);
  });

  it('refills continuously based on elapsed time', () => {
    const bucket = new RateBucket(900, 900, 0); // 900/min == 0.015 tokens/ms
    bucket.tryConsume(900, 0);
    expect(bucket.tryConsume(8, 500)).toBe(false); // 500ms -> 7.5 tokens, not enough for 8
    expect(bucket.tryConsume(7, 500)).toBe(true); // but enough for 7
    expect(bucket.peek(500 + 60_000)).toBeCloseTo(900, 0); // a full minute later, back at capacity
  });

  it('never exceeds capacity', () => {
    const bucket = new RateBucket(900, 900, 0);
    expect(bucket.peek(10 * 60_000)).toBe(900);
  });
});
