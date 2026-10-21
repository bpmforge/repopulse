import { describe, expect, it } from 'vitest';
import { CHURN_DECALS } from './FileDetail.js';

// W20-20 (UX_TODO DSH-55): gross, net and rework differed only by colour.
describe('file churn series patterns', () => {
  it('give Net and Rework distinct patterns, Gross stays solid', () => {
    expect(CHURN_DECALS.net).toBeDefined();
    expect(CHURN_DECALS.rework).toBeDefined();
    expect(CHURN_DECALS.net.symbol).not.toBe(CHURN_DECALS.rework.symbol);
    expect(Object.keys(CHURN_DECALS)).not.toContain('gross');
  });
});
