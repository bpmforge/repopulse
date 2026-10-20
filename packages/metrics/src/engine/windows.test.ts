import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_DAYS, WINDOW_DAYS, daysBetween, windowStart } from './windows.js';

describe('window constants', () => {
  // W20-16 (UX_TODO DSH-56): a 14-day preset for two-week sprints.
  it('matches the five documented windows, default 30d', () => {
    expect(WINDOW_DAYS).toEqual([7, 14, 30, 90, 365]);
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
  });
});

describe('windowStart / daysBetween', () => {
  it('computes the window start N days before the reference date', () => {
    const asOf = new Date('2026-07-07T00:00:00Z');
    expect(windowStart(asOf, 30).toISOString()).toBe('2026-06-07T00:00:00.000Z');
  });

  it('daysBetween matches METRICS.md §4 E1: 2026-07-05 -> 2026-07-07 is 2 days', () => {
    expect(daysBetween(new Date('2026-07-05T00:00:00Z'), new Date('2026-07-07T00:00:00Z'))).toBe(2);
  });

  it('daysBetween matches METRICS.md §4 E1: 2026-06-10 -> 2026-07-07 is 27 days', () => {
    expect(daysBetween(new Date('2026-06-10T00:00:00Z'), new Date('2026-07-07T00:00:00Z'))).toBe(
      27,
    );
  });
});
