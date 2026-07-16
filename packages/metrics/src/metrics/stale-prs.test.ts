import { describe, expect, it } from 'vitest';
import { computeStalePrs } from './stale-prs.js';
import { STALE_AS_OF, STALE_PRS_FIXTURE } from '../../fixtures/size-stale/stale-prs.js';

describe('computeStalePrs (METRICS.md §1 M8)', () => {
  it('flags PR #1 stale (8 days > 7-day default threshold)', () => {
    const result = computeStalePrs(STALE_PRS_FIXTURE, STALE_AS_OF);
    expect(result.stale.map((s) => s.pr)).toContain(1);
  });

  it('does not flag PR #2 (6 days, well under threshold)', () => {
    const result = computeStalePrs(STALE_PRS_FIXTURE, STALE_AS_OF);
    expect(result.stale.map((s) => s.pr)).not.toContain(2);
  });

  it('the threshold is strictly greater-than: exactly 7 days is NOT stale (PR #3)', () => {
    const result = computeStalePrs(STALE_PRS_FIXTURE, STALE_AS_OF);
    expect(result.stale.map((s) => s.pr)).not.toContain(3);
    expect(result.staleDrafts.map((s) => s.pr)).not.toContain(3);
  });

  it('reports drafts in a separate stale_drafts series, never mixed into stale', () => {
    const result = computeStalePrs(STALE_PRS_FIXTURE, STALE_AS_OF);
    expect(result.staleDrafts.map((s) => s.pr)).toEqual([4]);
    expect(result.stale.map((s) => s.pr)).not.toContain(4);
  });

  it('never considers a closed PR, regardless of activity age', () => {
    const result = computeStalePrs(STALE_PRS_FIXTURE, STALE_AS_OF);
    expect(result.stale.map((s) => s.pr)).not.toContain(5);
    expect(result.staleDrafts.map((s) => s.pr)).not.toContain(5);
  });

  it('counts reconcile exactly with the lists', () => {
    const result = computeStalePrs(STALE_PRS_FIXTURE, STALE_AS_OF);
    expect(result.staleCount).toBe(result.stale.length);
    expect(result.staleDraftCount).toBe(result.staleDrafts.length);
    expect(result.staleCount).toBe(1);
    expect(result.staleDraftCount).toBe(1);
  });

  it('honors a workspace-configurable threshold override', () => {
    const result = computeStalePrs(STALE_PRS_FIXTURE, STALE_AS_OF, 30);
    expect(result.staleCount).toBe(0);
    expect(result.staleDraftCount).toBe(0);
  });
});
