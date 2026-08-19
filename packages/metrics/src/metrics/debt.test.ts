import { describe, expect, it } from 'vitest';
import { computeRevertRate, computeRework14d, reworkByFile, M13_LOOKBACK_DAYS } from './debt.js';
import { METRIC_CATALOG } from '../catalog.js';
import type { ChurnFileTouch } from './churn.js';

// M13 / M14 debt signals (W9-05, FR-CH-7).
//
// A fixture history, reproduced to the line — these are the two metrics most
// likely to be quoted at someone in a meeting, so the arithmetic has to be
// checkable rather than plausible.

const touch = (path: string, day: number, additions: number, deletions = 0): ChurnFileTouch => ({
  path,
  sha: `${path}-${day}`,
  authorLogin: 'dev',
  parentShaCount: 1,
  superseded: false,
  touchedAt: new Date(Date.UTC(2026, 0, day)).toISOString(),
  additions,
  deletions,
});

describe('M13 rework-14d', () => {
  it('counts a re-touch inside the window and ignores one outside it', () => {
    // src/a.ts: touched day 1, again day 5 (inside 14d) => the second touch's
    // 20 lines are rework. src/b.ts: day 1 and day 20 (outside) => none.
    const touches = [
      touch('src/a.ts', 1, 10),
      touch('src/a.ts', 5, 20),
      touch('src/b.ts', 1, 30),
      touch('src/b.ts', 20, 40),
    ];
    const result = computeRework14d(touches);
    expect(result.reworkLines).toBe(20);
    expect(result.totalLines).toBe(100);
    expect(result.rate).toBeCloseTo(0.2, 10);
  });

  it('uses 14 days, deliberately NOT M1 rework 21 days', () => {
    // A touch 15 days later is rework under M1 and not under M13, and that
    // difference is the point: M1 measures churn quality over a sprint, M13
    // measures work redone almost immediately.
    const fifteenDaysLater = [touch('src/a.ts', 1, 10), touch('src/a.ts', 16, 10)];
    expect(computeRework14d(fifteenDaysLater).reworkLines).toBe(0);
    expect(computeRework14d(fifteenDaysLater, 21).reworkLines).toBe(10);
    expect(M13_LOOKBACK_DAYS).toBe(14);
  });

  it('is exclusive at the boundary: exactly 14 days is not rework', () => {
    const exactly = [touch('src/a.ts', 1, 10), touch('src/a.ts', 15, 10)];
    expect(computeRework14d(exactly).reworkLines).toBe(0);
    const justInside = [touch('src/a.ts', 1, 10), touch('src/a.ts', 14, 10)];
    expect(computeRework14d(justInside).reworkLines).toBe(10);
  });

  it('counts deletions as changed lines, not just additions', () => {
    const touches = [touch('src/a.ts', 1, 0, 5), touch('src/a.ts', 3, 0, 7)];
    expect(computeRework14d(touches)).toMatchObject({ reworkLines: 7, totalLines: 12 });
  });

  it('is NULL over an empty window, never 0', () => {
    // A 0% rework rate for a week with no commits reads as a perfect week.
    expect(computeRework14d([]).rate).toBeNull();
  });

  it('keeps files independent', () => {
    // Two files touched a day apart are not rework of each other.
    const touches = [touch('src/a.ts', 1, 10), touch('src/b.ts', 2, 10)];
    expect(computeRework14d(touches).reworkLines).toBe(0);
  });

  it('reports per file for the file grain', () => {
    const touches = [touch('src/a.ts', 1, 10), touch('src/a.ts', 4, 10), touch('src/b.ts', 1, 10)];
    const byFile = reworkByFile(touches);
    expect(byFile.get('src/a.ts')?.reworkLines).toBe(10);
    expect(byFile.get('src/b.ts')?.reworkLines).toBe(0);
  });
});

describe('M14 revert rate', () => {
  const commit = (
    sha: string,
    over: Partial<{ isMerge: boolean; isRevertHeuristic: boolean; isBot: boolean }> = {},
  ) => ({
    sha,
    isMerge: false,
    isRevertHeuristic: false,
    ...over,
  });

  it('divides reverts by NON-MERGE commits', () => {
    // Merges are excluded on the §0 grounds every metric excludes them: a
    // squash-merging team would otherwise look healthier than a
    // merge-committing one for reasons unrelated to reverts.
    const commits = [
      commit('a'),
      commit('b', { isRevertHeuristic: true }),
      commit('c'),
      commit('m', { isMerge: true }),
      commit('m2', { isMerge: true }),
    ];
    const result = computeRevertRate(commits);
    expect(result.reverts).toBe(1);
    expect(result.eligibleCommits).toBe(3);
    expect(result.rate).toBeCloseTo(1 / 3, 10);
  });

  it('excludes bots from the denominator', () => {
    const commits = [commit('a'), commit('bot', { isBot: true })];
    expect(computeRevertRate(commits).eligibleCommits).toBe(1);
  });

  it('is NULL when nothing landed, never 0', () => {
    expect(computeRevertRate([]).rate).toBeNull();
    expect(computeRevertRate([commit('m', { isMerge: true })]).rate).toBeNull();
  });
});

describe('the catalog carries both, with their caveats', () => {
  it('registers M13 and M14', () => {
    const ids = METRIC_CATALOG.map((m) => m.id);
    expect(ids).toContain('M13');
    expect(ids).toContain('M14');
  });

  it('says M14 is a heuristic and that a revert is often correct', () => {
    // The caveat is the deliverable. A revert rate without it becomes a target,
    // and a team that stops reverting bad deploys is not a healthier team.
    const m14 = METRIC_CATALOG.find((m) => m.id === 'M14');
    expect(m14?.heuristicNotes).toMatch(/HEURISTIC/);
    expect(m14?.heuristicNotes).toMatch(/CORRECT response/i);
  });

  it('explains why M13 uses a different window from M1', () => {
    const m13 = METRIC_CATALOG.find((m) => m.id === 'M13');
    expect(m13?.heuristicNotes).toMatch(/14-day window/);
    expect(m13?.heuristicNotes).toMatch(/21d/);
  });
});
