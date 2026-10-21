import { describe, expect, it } from 'vitest';
import { effectiveShares } from './contracts.js';

// W20-22 (UX_TODO ADM-60): the form shows all seven sub-scores and what each
// really counts for once the three measured-only ones are added on top.
describe('effectiveShares', () => {
  it('scales the default weights over all seven sub-scores', () => {
    const shares = effectiveShares({
      activity: 0.2,
      reviewHygiene: 0.3,
      ciHealth: 0.25,
      delivery: 0.25,
    });
    expect(shares.map((s) => s.key)).toEqual([
      'activity',
      'reviewHygiene',
      'ciHealth',
      'delivery',
      'security',
      'codeHealth',
      'supplyChain',
    ]);
    // 0.20 of a 1.45 total: about 14 %.
    expect(Math.round(shares[0]!.share * 100)).toBe(14);
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
    expect(shares.filter((s) => !s.editable).map((s) => s.key)).toEqual([
      'security',
      'codeHealth',
      'supplyChain',
    ]);
  });
});
