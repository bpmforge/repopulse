import { describe, expect, it } from 'vitest';
import { daysLeft, tokenExpiryState, warningStartsAt } from './token-expiry.js';

const now = new Date('2026-10-22T12:00:00Z');
const inDays = (d: number) => new Date(now.getTime() + d * 24 * 60 * 60 * 1000);

describe('tokenExpiryState (W20-25, ADM-50)', () => {
  it('warns from 14 days before expiry, and says expired after it', () => {
    expect(tokenExpiryState(null, now)).toBe('unknown');
    expect(tokenExpiryState(inDays(30), now)).toBe('ok');
    expect(tokenExpiryState(inDays(14.5), now)).toBe('ok');
    expect(tokenExpiryState(inDays(14), now)).toBe('expiring');
    expect(tokenExpiryState(inDays(1), now)).toBe('expiring');
    expect(tokenExpiryState(inDays(-1), now)).toBe('expired');
  });

  it('dates the start of the warning and counts whole days', () => {
    expect(warningStartsAt(inDays(20)).toISOString()).toBe(inDays(6).toISOString());
    expect(daysLeft(inDays(3.5), now)).toBe(3);
    expect(daysLeft(inDays(-0.5), now)).toBe(-1);
  });
});
