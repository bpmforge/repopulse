import { describe, expect, it } from 'vitest';
import { sessionLifetime } from './session-lifetime.js';

describe('sessionLifetime (FR-AUTH-2)', () => {
  it('keeps 15 minutes idle and 12 hours absolute when unset', () => {
    expect(sessionLifetime({})).toEqual({
      idleTimeoutMs: 15 * 60_000,
      absoluteLifetimeMs: 12 * 3_600_000,
    });
  });

  it('reads both from the environment', () => {
    expect(sessionLifetime({ SESSION_IDLE_MINUTES: '60', SESSION_MAX_HOURS: '24' })).toEqual({
      idleTimeoutMs: 60 * 60_000,
      absoluteLifetimeMs: 24 * 3_600_000,
    });
  });

  it('falls back to the default for nonsense, zero or out-of-range values', () => {
    for (const bad of ['abc', '0', '-5', '2.5', '4', '100000', ' ']) {
      expect(sessionLifetime({ SESSION_IDLE_MINUTES: bad }).idleTimeoutMs).toBe(15 * 60_000);
    }
    expect(sessionLifetime({ SESSION_MAX_HOURS: '0' }).absoluteLifetimeMs).toBe(12 * 3_600_000);
  });

  it('never lets the absolute cap be shorter than the idle timeout', () => {
    const l = sessionLifetime({ SESSION_IDLE_MINUTES: '600', SESSION_MAX_HOURS: '1' });
    expect(l.absoluteLifetimeMs).toBe(l.idleTimeoutMs);
  });
});
