import { describe, expect, it } from 'vitest';
import { hotspotSinceIntent } from './IntentControl.js';
import { intentWarningText } from '../org/contracts.js';
import { waitingOf } from '../me/contracts.js';

// W20-24. DSH-37: whether a file's hotspot improved since its intent, and the
// lapsed intents Needs attention lists. DSH-41: the review queue's wait is
// measured from the request when it is known, and says when it is not.

const base = {
  id: 1,
  repo_id: 2,
  path: 'src/hot.ts',
  intent: 'refactor',
  note: null,
  warn_after_months: 3,
  created_at: '2026-06-12T00:00:00.000Z',
};
const point = (at: string, score: number) => ({ at, score });

describe('hotspot since the intent (DSH-37)', () => {
  it('says there is not enough history with one reading', () => {
    expect(
      hotspotSinceIntent({
        ...base,
        hotspot: {
          first: point('2026-06-12T00:00:00.000Z', 0.8),
          latest: point('2026-06-12T00:00:00.000Z', 0.8),
          points: 1,
          improved: null,
          warnings: [],
        },
      }),
    ).toMatch(/Not enough hotspot history/);
  });

  it('reports an improvement with both readings', () => {
    expect(
      hotspotSinceIntent({
        ...base,
        hotspot: {
          first: point('2026-06-12T00:00:00.000Z', 0.8),
          latest: point('2026-07-01T00:00:00.000Z', 0.4),
          points: 2,
          improved: true,
          warnings: [],
        },
      }),
    ).toBe('Improved since the intent: hotspot 0.80 on 2026-06-12 → 0.40 on 2026-07-01.');
  });

  it('warns when a refactor has stalled past its review date', () => {
    expect(
      hotspotSinceIntent({
        ...base,
        hotspot: {
          first: point('2026-06-12T00:00:00.000Z', 0.8),
          latest: point('2026-10-01T00:00:00.000Z', 0.85),
          points: 9,
          improved: false,
          warnings: [{ kind: 'refactor_stalled', months: 3, from: 0.8, to: 0.85 }],
        },
      }),
    ).toMatch(/^⚠ No improvement in 3 months/);
  });

  it('says nothing for an acknowledged file or an older API', () => {
    expect(hotspotSinceIntent({ ...base, intent: 'acknowledged' })).toBeNull();
    expect(hotspotSinceIntent(base)).toBeNull();
  });

  it('phrases a lapsed intent for Needs attention', () => {
    const row = {
      kind: 'refactor_stalled' as const,
      repo_id: 2,
      org: 'acme',
      name: 'api',
      path: 'src/hot.ts',
      intent: 'refactor',
      since: '2026-06-12T00:00:00.000Z',
      from: 0.8,
      to: 0.85,
      months: 4,
    };
    expect(intentWarningText(row)).toBe(
      'Refactor since 2026-06-12: no improvement in 4 months (hotspot 0.80 → 0.85)',
    );
    expect(intentWarningText({ ...row, kind: 'supervised_decline', intent: 'supervise' })).toBe(
      'Supervised since 2026-06-12: hotspot rising (hotspot 0.80 → 0.85)',
    );
  });
});

describe('review queue waiting time (DSH-41)', () => {
  const row = {
    number: 5,
    title: 't',
    repo_id: 1,
    repo: { id: 1, org: 'acme', name: 'api' },
    author: 'dev',
    opened_at: '2026-10-01T00:00:00.000Z',
    links: { self: '' },
  };
  it('measures from the request when it is known', () => {
    expect(
      waitingOf({
        ...row,
        waiting_since: '2026-10-20T00:00:00.000Z',
        waiting_basis: 'review_request',
        request_source: 'timeline',
      }),
    ).toEqual({ since: '2026-10-20T00:00:00.000Z', fromRequest: true, approximate: false });
  });
  it('marks a request first seen on a sync as approximate', () => {
    expect(
      waitingOf({
        ...row,
        waiting_since: '2026-10-20T00:00:00.000Z',
        waiting_basis: 'review_request',
        request_source: 'observed',
      }).approximate,
    ).toBe(true);
  });
  it('falls back to the opening time, and says so, otherwise', () => {
    expect(waitingOf({ ...row, waiting_since: row.opened_at, waiting_basis: 'opened' })).toEqual({
      since: row.opened_at,
      fromRequest: false,
      approximate: false,
    });
    expect(waitingOf(row).fromRequest).toBe(false);
  });
});
