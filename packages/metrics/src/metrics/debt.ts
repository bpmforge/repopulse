import type { ChurnFileTouch } from './churn.js';

// Debt signals M13 and M14 (W9-05, CODE_HEALTH_SUITE.md, FR-CH-7).
//
// Two cheap, deterministic numbers that say something the LLM layers cannot:
// how much of this week's work is redoing last week's, and how often the team
// has to undo a change outright.
//
// NEITHER IS A VERDICT. High rework is normal in a young feature and alarming
// in a mature one; a revert is often the correct, healthy response to a bad
// deploy. They are shipped with heuristic notes for exactly that reason — a
// number without its caveat becomes a target, and a target stops measuring.

/**
 * M13 rework-14d: share of line changes touching a file changed <14 days ago.
 *
 * FOURTEEN DAYS, NOT M1's TWENTY-ONE, and the difference is the point rather
 * than an inconsistency: M1's rework is a churn-quality signal over a sprint's
 * horizon, while M13 is a DEBT signal — work redone almost immediately, which
 * is what "we did not understand the problem yet" looks like in a log. Changing
 * M1's window to match would move a number people already have history for.
 */
export const M13_LOOKBACK_DAYS = 14;

export interface DebtWindowResult {
  /** Lines that qualified as rework. */
  reworkLines: number;
  /** All eligible lines in the window. */
  totalLines: number;
  /** null when there were no lines at all — NOT 0. */
  rate: number | null;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 86_400_000;
}

/** One touch's share of M13: the lines it changed, and how many of them were rework. */
export interface Rework14dAttribution {
  touch: ChurnFileTouch;
  /** 0 when the previous touch of the same path is ≥ lookbackDays earlier (or absent). */
  reworkLines: number;
}

/**
 * Per-touch M13 attribution, the basis computeRework14d sums.
 *
 * Exported for the same reason churn.ts exports attributeRework: a SLICE of
 * M13 (W18-20 slices it by authorship) must be computed over the full touch
 * history and then grouped, never by filtering touches first. Filtering first
 * would make "the previous touch" the previous touch BY THE SAME COHORT, and
 * an AI change that rewrites a human change from last week would stop counting
 * as rework at all.
 */
export function attributeRework14d(
  touches: readonly ChurnFileTouch[],
  lookbackDays = M13_LOOKBACK_DAYS,
): Rework14dAttribution[] {
  const byPath = new Map<string, ChurnFileTouch[]>();
  for (const touch of touches) {
    const bucket = byPath.get(touch.path);
    if (bucket) bucket.push(touch);
    else byPath.set(touch.path, [touch]);
  }

  const rework = new Map<ChurnFileTouch, number>();
  for (const bucket of byPath.values()) {
    const byTime = [...bucket].sort(
      (a, b) => new Date(a.touchedAt).getTime() - new Date(b.touchedAt).getTime(),
    );
    for (let i = 1; i < byTime.length; i++) {
      const prev = byTime[i - 1] as ChurnFileTouch;
      const curr = byTime[i] as ChurnFileTouch;
      if (daysBetween(new Date(prev.touchedAt), new Date(curr.touchedAt)) < lookbackDays) {
        rework.set(curr, curr.additions + curr.deletions);
      }
    }
  }
  return touches.map((touch) => ({ touch, reworkLines: rework.get(touch) ?? 0 }));
}

/** M13 from attributed touches — null over an empty set, never 0. */
export function sumRework14d(attributed: readonly Rework14dAttribution[]): DebtWindowResult {
  let reworkLines = 0;
  let totalLines = 0;
  for (const a of attributed) {
    reworkLines += a.reworkLines;
    totalLines += a.touch.additions + a.touch.deletions;
  }
  return {
    reworkLines,
    totalLines,
    // null over an empty window: a 0% rework rate for a week with no commits
    // reads as a perfect week, which is the opposite of "nothing happened".
    rate: totalLines === 0 ? null : reworkLines / totalLines,
  };
}

/**
 * M13 over a set of file touches.
 *
 * Touches are grouped by path and walked in time order, so "the previous
 * touch" is the immediately preceding one — the same discipline as M1's
 * attribution, and for the same reason: bucketing first would zero the rework
 * of every touch that happens to be first in its bucket.
 */
export function computeRework14d(
  touches: readonly ChurnFileTouch[],
  lookbackDays = M13_LOOKBACK_DAYS,
): DebtWindowResult {
  return sumRework14d(attributeRework14d(touches, lookbackDays));
}

export interface RevertCommit {
  sha: string;
  isMerge: boolean;
  isRevertHeuristic: boolean;
  isBot?: boolean;
}

export interface RevertRateResult {
  reverts: number;
  eligibleCommits: number;
  /** null when nothing landed in the window. */
  rate: number | null;
}

/**
 * M14 revert rate: reverting commits over non-merge commits.
 *
 * MERGES ARE EXCLUDED from the denominator on the same §0 grounds every other
 * metric excludes them: a merge commit is a bookkeeping artefact of a branching
 * strategy, and including them would make a squash-merging team look healthier
 * than a merge-committing one for reasons that have nothing to do with reverts.
 */
export function computeRevertRate(commits: readonly RevertCommit[]): RevertRateResult {
  const eligible = commits.filter((c) => !c.isMerge && c.isBot !== true);
  const reverts = eligible.filter((c) => c.isRevertHeuristic).length;
  return {
    reverts,
    eligibleCommits: eligible.length,
    rate: eligible.length === 0 ? null : reverts / eligible.length,
  };
}

/** Per-file M13, for the file grain the catalog promises. */
export function reworkByFile(
  touches: readonly ChurnFileTouch[],
  lookbackDays = M13_LOOKBACK_DAYS,
): Map<string, DebtWindowResult> {
  const paths = new Set(touches.map((t) => t.path));
  const out = new Map<string, DebtWindowResult>();
  for (const path of paths) {
    out.set(
      path,
      computeRework14d(
        touches.filter((t) => t.path === path),
        lookbackDays,
      ),
    );
  }
  return out;
}
