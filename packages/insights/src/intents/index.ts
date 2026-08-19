// Artifact intents (W6-07, IMPROVEMENT_PLANS.md §4, FR-PLANS-5).

export type Intent = 'refactor' | 'supervise' | 'acknowledged';

export interface FileIntent {
  repoId: number;
  path: string;
  intent: Intent;
  createdAt: Date;
  warnAfterMonths: number;
}

/** One hotspot observation, oldest first, for judging whether an intent held. */
export interface HotspotPoint {
  at: Date;
  score: number;
}

export type IntentWarning =
  | { kind: 'refactor_stalled'; path: string; months: number; from: number; to: number }
  | { kind: 'supervised_decline'; path: string; from: number; to: number };

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Warnings an intent has earned.
 *
 * A `refactor` intent is a promise with a date on it: if the file's hotspot
 * score has not improved within warn_after_months, the promise has quietly
 * expired and saying so is the entire value of recording it. An intent nobody
 * is ever reminded about is a comment, not a plan.
 */
export function intentWarnings(
  intent: FileIntent,
  history: readonly HotspotPoint[],
  now: Date,
): IntentWarning[] {
  // Only points from the intent onward: improvement that happened BEFORE
  // someone declared the intent is not evidence the intent worked.
  const since = history
    .filter((p) => p.at >= intent.createdAt)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = since[0];
  const last = since[since.length - 1];
  if (!first || !last || since.length < 2) return [];

  if (intent.intent === 'refactor') {
    const ageMonths = (now.getTime() - intent.createdAt.getTime()) / MONTH_MS;
    if (ageMonths < intent.warnAfterMonths) return [];
    // "Not improved" includes getting worse AND standing still. A refactor
    // intent that held the score flat for three months did not happen.
    if (last.score >= first.score) {
      return [
        {
          kind: 'refactor_stalled',
          path: intent.path,
          months: Math.floor(ageMonths),
          from: first.score,
          to: last.score,
        },
      ];
    }
    return [];
  }

  if (intent.intent === 'supervise') {
    // Any decline, immediately — that is what supervising means. No grace
    // period: the point of the intent is to hear about it early.
    if (last.score > first.score) {
      return [{ kind: 'supervised_decline', path: intent.path, from: first.score, to: last.score }];
    }
    return [];
  }

  // acknowledged: the team has decided. No warnings, ever — an intent that
  // keeps nagging after an explicit decision is why people stop using them.
  return [];
}

export interface HotspotRow {
  repoId: number;
  path: string;
  score: number;
}

export interface SuppressionResult<T extends HotspotRow> {
  visible: T[];
  /** How many rows were hidden — shown as a badge so the list stays honest. */
  suppressedCount: number;
  suppressedPaths: string[];
}

/**
 * Applies `acknowledged` suppression to a hotspot leaderboard.
 *
 * Suppressed from the LIST, never from the data (§4). The count is returned so
 * the UI can say "3 acknowledged files hidden" — a leaderboard that silently
 * omits rows is one nobody can reason about, and the first person to notice
 * stops trusting every other number on the screen.
 */
export function applySuppression<T extends HotspotRow>(
  rows: readonly T[],
  intents: readonly FileIntent[],
): SuppressionResult<T> {
  // Keyed on repoId AND path. Keying on path alone meant acknowledging
  // src/index.ts in one repository hid src/index.ts in EVERY repository — and
  // common filenames are exactly the ones a monorepo repeats. Caught by an e2e
  // that expected one suppression and found two.
  const key = (repoId: number, path: string) => `${repoId}\u0000${path}`;
  const acknowledged = new Set(
    intents.filter((i) => i.intent === 'acknowledged').map((i) => key(i.repoId, i.path)),
  );
  const visible = rows.filter((r) => !acknowledged.has(key(r.repoId, r.path)));
  const suppressedPaths = rows
    .filter((r) => acknowledged.has(key(r.repoId, r.path)))
    .map((r) => r.path);
  return { visible, suppressedCount: suppressedPaths.length, suppressedPaths };
}
