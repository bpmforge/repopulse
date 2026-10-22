import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanItemCard } from './PlanItemCard.js';
import { matchesOwnerFilter, ownerLabel, type PlanItem, type PlanOwner } from './contracts.js';
import { validatePlansSearch } from '../../routes/plans/index.js';

// W20-24 (UX_TODO DSH-44; decision 2026-10-21): an improvement-plan item has
// an optional owner, a workspace member, set on the item and filterable.

const mutate = vi.fn();
vi.mock('../../api/useApiQuery.js', () => ({
  useApiMutation: () => ({ mutate, isPending: false, error: null }),
  useApiQuery: () => ({ data: undefined }),
  queryKeyFor: () => [],
}));

beforeEach(() => {
  mutate.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

const owners = [
  { id: 3, login: 'ana', name: 'Ana Lima' },
  { id: 4, login: 'bo', name: null },
];

function item(owner: PlanOwner | null, status: PlanItem['status'] = 'accepted'): PlanItem {
  return {
    id: 9,
    rank: 1,
    catalog_id: 'review-coverage-low',
    source: 'metric',
    recommendation: 'Adopt a review SLA',
    effort: 'M',
    status,
    evidence: {},
    verify_criterion: { metricKey: 'M5', op: 'gte', target: 0.8, windowDays: 30 },
    verified_at: null,
    owner,
  };
}

describe('plan item owner (W20-24, DSH-44)', () => {
  it('shows the owner and hands the item to another member', () => {
    render(<PlanItemCard item={item(owners[0]!)} owners={owners} />);
    const select = screen.getByTestId('plan-item-owner-select-9') as HTMLSelectElement;
    expect(select.value).toBe('3');
    fireEvent.change(select, { target: { value: '4' } });
    expect(mutate).toHaveBeenCalledWith({ owner_user_id: 4 });
    fireEvent.change(select, { target: { value: '' } });
    expect(mutate).toHaveBeenLastCalledWith({ owner_user_id: null });
  });

  it('says nobody yet, and is read-only without a member list', () => {
    render(<PlanItemCard item={item(null)} />);
    expect(screen.getByTestId('plan-item-owner-9').textContent).toBe('Owner: nobody yet');
    expect(screen.queryByTestId('plan-item-owner-select-9')).toBeNull();
  });

  it('keeps an owner who is no longer listed selectable rather than blank', () => {
    render(<PlanItemCard item={item({ id: 99, login: 'gone', name: null })} owners={owners} />);
    const select = screen.getByTestId('plan-item-owner-select-9') as HTMLSelectElement;
    expect(select.value).toBe('99');
  });

  it('labels a member by name and login', () => {
    expect(ownerLabel(owners[0]!)).toBe('Ana Lima (ana)');
    expect(ownerLabel(owners[1]!)).toBe('bo');
  });

  it('filters by me, nobody, or one member', () => {
    const mine = item(owners[0]!);
    const nobody = item(null);
    expect(matchesOwnerFilter(mine, undefined, 3)).toBe(true);
    expect(matchesOwnerFilter(mine, 'me', 3)).toBe(true);
    expect(matchesOwnerFilter(mine, 'me', 4)).toBe(false);
    expect(matchesOwnerFilter(mine, 'me', undefined)).toBe(false);
    expect(matchesOwnerFilter(nobody, 'none', 3)).toBe(true);
    expect(matchesOwnerFilter(mine, 'none', 3)).toBe(false);
    expect(matchesOwnerFilter(mine, '3', undefined)).toBe(true);
    expect(matchesOwnerFilter(nobody, '3', undefined)).toBe(false);
  });

  it('keeps only a well-formed owner filter in the URL', () => {
    expect(validatePlansSearch({ owner: 'me' })).toEqual({ owner: 'me' });
    expect(validatePlansSearch({ owner: 'none' })).toEqual({ owner: 'none' });
    expect(validatePlansSearch({ owner: 12 })).toEqual({ owner: '12' });
    expect(validatePlansSearch({ owner: 'x; drop' })).toEqual({});
    expect(validatePlansSearch({ owner: '0' })).toEqual({});
  });
});
