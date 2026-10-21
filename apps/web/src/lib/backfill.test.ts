import { describe, expect, it } from 'vitest';
import { backfillPoll, backfillState } from './backfill.js';
import { frameState } from '../components/widget/WidgetFrame.js';

// W20-22 (UX_TODO INS-35): a filling install read as an empty org on every
// Overview card except the health tiles.
describe('backfillState', () => {
  it('is settled when nothing is loading', () => {
    const status = { repos: [{ phase: 'live', percentComplete: 100 }] };
    expect(backfillState(status, {})).toEqual({ syncing: false, pct: 100 });
    expect(backfillPoll(status)).toBe(false);
  });

  it('is syncing while any repository is still loading its history', () => {
    const status = {
      repos: [
        { phase: 'history', percentComplete: 20 },
        { phase: 'enrichment', percentComplete: 60 },
        { phase: 'live', percentComplete: 100 },
      ],
    };
    expect(backfillState(status, {})).toEqual({ syncing: true, pct: 40 });
    expect(backfillPoll(status)).toBe(15_000);
  });

  it('prefers live progress events, and works with no status yet', () => {
    expect(backfillState(undefined, { 4: { pct: 70 } })).toEqual({ syncing: true, pct: 70 });
  });

  it('turns an empty card into "still loading" only while syncing', () => {
    const empty = { isLoading: false, isError: false, isEmpty: true };
    expect(frameState({ ...empty, isSyncing: true })).toBe('syncing');
    expect(frameState({ ...empty, isSyncing: false })).toBe('empty');
  });
});
