import { describe, expect, it } from 'vitest';
import { diffReports } from './index.js';
import type { ReportData, ReportParams } from '../types/index.js';

// Report diff (W5-09, R-A9).

const params = (over: Partial<ReportParams> = {}): ReportParams => ({
  type: 'repo_health',
  workspaceId: '1',
  repoIds: ['7'],
  windowDays: 30,
  windowEnd: '2026-08-01T00:00:00.000Z',
  snapshotAt: '2026-08-01T00:00:00.000Z',
  weightsVersion: 'v1',
  catalogVersion: 'v1',
  ...over,
});

const report = (rows: unknown[][], p: Partial<ReportParams> = {}): ReportData => ({
  params: params(p),
  sections: [{ kind: 'table', id: 'ci', columns: ['Measure', 'Value'], rows }],
  appendix: { definitions: [] },
  dataQuality: [],
});

describe('report diff', () => {
  it('computes per-row deltas between two comparable reports', () => {
    const diff = diffReports(report([['Pass rate', 0.7]]), report([['Pass rate', 0.9]]));
    expect(diff.comparable).toBe(true);
    expect(diff.deltas[0]).toMatchObject({ label: 'Pass rate', before: 0.7, after: 0.9 });
    expect(diff.deltas[0]?.delta).toBeCloseTo(0.2);
  });

  it('marks a row that exists on only one side, with a NULL delta', () => {
    // A metric that appeared this month has not "increased from zero", and
    // rendering it as growth would invent a trend nobody can defend.
    const diff = diffReports(report([]), report([['Flakiness', 0.3]]));
    expect(diff.deltas[0]).toMatchObject({ before: null, after: 0.3, delta: null, onlyOneSide: true });
  });

  it('reports a row that DISAPPEARED — that is movement too', () => {
    // A hotspot dropping off the list is exactly what a reader wants to see.
    const diff = diffReports(report([['Old hotspot', 0.8]]), report([]));
    expect(diff.deltas[0]).toMatchObject({ label: 'Old hotspot', before: 0.8, after: null, onlyOneSide: true });
  });

  it('REFUSES to compare different report types', () => {
    const diff = diffReports(report([]), report([], { type: 'delivery_dora' }));
    expect(diff.comparable).toBe(false);
    expect(diff.reason).toMatch(/Different report types/);
    expect(diff.deltas).toEqual([]);
  });

  it('refuses different windows — a 7-day and a 90-day figure are not the same measurement', () => {
    const diff = diffReports(report([]), report([], { windowDays: 90 }));
    expect(diff.comparable).toBe(false);
    expect(diff.reason).toMatch(/Different windows/);
  });

  it('refuses different repo scopes', () => {
    // Otherwise a change in what was measured renders as a change in the work.
    const diff = diffReports(report([]), report([], { repoIds: ['7', '8'] }));
    expect(diff.comparable).toBe(false);
    expect(diff.reason).toMatch(/scope/i);
  });
});
