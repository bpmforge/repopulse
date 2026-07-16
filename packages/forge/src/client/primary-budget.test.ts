import { describe, expect, it } from 'vitest';
import { PrimaryBudget } from './primary-budget.js';

describe('PrimaryBudget', () => {
  it('admits every lane before any response is seen (never guessed)', () => {
    const budget = new PrimaryBudget({ floor: 100 });
    expect(budget.snapshot()).toEqual({ remaining: null, limit: null, resetAt: null });
    expect(budget.admits('backfill')).toBe(true);
    expect(budget.admits('reconcile')).toBe(true);
    expect(budget.admits('webhook')).toBe(true);
    expect(budget.admits('user')).toBe(true);
  });

  it('only moves off real x-ratelimit-* headers, never a guess', () => {
    const budget = new PrimaryBudget({ floor: 100 });
    budget.seedFromHeaders({ remaining: 4500, limit: 5000, resetAt: 1_700_000_000_000 });
    expect(budget.snapshot()).toEqual({
      remaining: 4500,
      limit: 5000,
      resetAt: 1_700_000_000_000,
    });
  });

  // FR-FORGE-3 acceptance: "simulated 100-remaining response ... no request
  // is emitted once budget floor is hit" - at/below the floor, backfill and
  // reconcile park; webhook/user may still drain the reserve down to zero.
  it('parks backfill/reconcile at the floor while webhook/user drain the reserve', () => {
    const budget = new PrimaryBudget({ floor: 100 });
    budget.seedFromHeaders({ remaining: 100 });
    expect(budget.admits('backfill')).toBe(false);
    expect(budget.admits('reconcile')).toBe(false);
    expect(budget.admits('webhook')).toBe(true);
    expect(budget.admits('user')).toBe(true);
  });

  it('denies every lane once the reserve itself hits zero', () => {
    const budget = new PrimaryBudget({ floor: 100 });
    budget.seedFromHeaders({ remaining: 0 });
    expect(budget.admits('webhook')).toBe(false);
    expect(budget.admits('user')).toBe(false);
    expect(budget.admits('backfill')).toBe(false);
    expect(budget.admits('reconcile')).toBe(false);
  });

  it('admits every lane comfortably above the floor', () => {
    const budget = new PrimaryBudget({ floor: 100 });
    budget.seedFromHeaders({ remaining: 5000 });
    expect(budget.admits('backfill')).toBe(true);
    expect(budget.admits('reconcile')).toBe(true);
  });

  it('reserve() optimistically decrements between real header updates', () => {
    const budget = new PrimaryBudget({ floor: 100 });
    budget.seedFromHeaders({ remaining: 105 });
    budget.reserve(10);
    expect(budget.snapshot().remaining).toBe(95);
    expect(budget.admits('backfill')).toBe(false);
  });
});
