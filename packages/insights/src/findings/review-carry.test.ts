import { describe, expect, it } from 'vitest';
import { planReviewCarry, type PriorReviewFinding } from './review-carry.js';

const f = (id: number, status = 'open', file: string | null = `f${id}.ts`): PriorReviewFinding => ({
  id,
  file,
  evidence: `q${id}`,
  status,
});

describe('planReviewCarry (W23-07)', () => {
  it('carries what the new diff still quotes and closes what it does not', () => {
    const plan = planReviewCarry([f(1), f(2), f(3, 'confirmed')], new Set(), (_file, q) => q !== 'q2');
    expect(plan).toEqual({ carry: [1, 3], close: [2] });
  });

  it('leaves findings the new pass already re-raised, and those a person closed', () => {
    const plan = planReviewCarry(
      [f(1), f(2, 'dismissed'), f(3, 'wont_fix'), f(4, 'resolved')],
      new Set([1]),
      () => false,
    );
    expect(plan).toEqual({ carry: [], close: [] });
  });

  it('closes a finding with no file (nothing to find the quote in)', () => {
    expect(planReviewCarry([f(1, 'open', null)], new Set(), () => true).close).toEqual([1]);
  });
});
