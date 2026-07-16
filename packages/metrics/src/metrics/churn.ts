import { isEligibleForChurn } from '../engine/exclusions.js';
import { daysBetween } from '../engine/windows.js';

// METRICS.md §1 M1: file-touch granularity (commit_file rows), not whole
// commits - exclusion (bot/merge/superseded) is still decided at the
// commit level, since a single commit's touches all share one author and
// one parent-count.
export interface ChurnFileTouch {
  sha: string;
  authorLogin: string;
  parentShaCount: number;
  superseded: boolean;
  path: string;
  /** Set only on a 'renamed' touch - churn follows this chain (METRICS.md §1 M1). */
  previousPath?: string;
  additions: number;
  deletions: number;
  touchedAt: string; // ISO - the commit's authoredAt
}

export interface ChurnResult {
  gross: number;
  net: number;
  rework: number;
}

function resolveCanonicalPath(aliasOf: ReadonlyMap<string, string>, path: string): string {
  let root = path;
  const seen = new Set<string>();
  while (aliasOf.has(root) && !seen.has(root)) {
    seen.add(root);
    root = aliasOf.get(root) as string;
  }
  return root;
}

/** Rename chains: a touch's path becomes an alias of wherever previousPath currently resolves. */
function buildRenameAliases(touches: readonly ChurnFileTouch[]): Map<string, string> {
  const byTime = [...touches].sort(
    (a, b) => new Date(a.touchedAt).getTime() - new Date(b.touchedAt).getTime(),
  );
  const aliasOf = new Map<string, string>();
  for (const t of byTime) {
    if (t.previousPath && t.previousPath !== t.path) {
      aliasOf.set(t.path, resolveCanonicalPath(aliasOf, t.previousPath));
    }
  }
  return aliasOf;
}

const REWORK_LOOKBACK_DAYS = 21;

function computeRework(eligible: readonly ChurnFileTouch[]): number {
  const aliasOf = buildRenameAliases(eligible);
  const byCanonicalPath = new Map<string, ChurnFileTouch[]>();
  for (const t of eligible) {
    const key = resolveCanonicalPath(aliasOf, t.path);
    const bucket = byCanonicalPath.get(key);
    if (bucket) bucket.push(t);
    else byCanonicalPath.set(key, [t]);
  }

  let rework = 0;
  for (const touches of byCanonicalPath.values()) {
    const byTime = [...touches].sort(
      (a, b) => new Date(a.touchedAt).getTime() - new Date(b.touchedAt).getTime(),
    );
    // Touches are time-ordered, so the immediately-preceding touch is
    // always the closest prior one - if it isn't within the lookback
    // window, no earlier touch can be either.
    for (let i = 1; i < byTime.length; i++) {
      const prev = byTime[i - 1] as ChurnFileTouch;
      const curr = byTime[i] as ChurnFileTouch;
      if (daysBetween(new Date(prev.touchedAt), new Date(curr.touchedAt)) < REWORK_LOOKBACK_DAYS) {
        rework += curr.additions + curr.deletions;
      }
    }
  }
  return rework;
}

/** METRICS.md §1 M1: gross/net/rework over eligible (non-bot, non-merge, non-superseded) touches. */
export function computeChurn(
  touches: readonly ChurnFileTouch[],
  botGlobs?: readonly string[],
): ChurnResult {
  const eligible = touches.filter((t) =>
    isEligibleForChurn(
      { authorLogin: t.authorLogin, parentShaCount: t.parentShaCount, superseded: t.superseded },
      botGlobs,
    ),
  );

  let gross = 0;
  let net = 0;
  for (const t of eligible) {
    gross += t.additions + t.deletions;
    net += t.additions - t.deletions;
  }

  return { gross, net, rework: computeRework(eligible) };
}

/** file grain: churn scoped to touches on a single canonical path (renames included). */
export function computeFileChurn(
  touches: readonly ChurnFileTouch[],
  path: string,
  botGlobs?: readonly string[],
): ChurnResult {
  const aliasOf = buildRenameAliases(touches);
  const target = resolveCanonicalPath(aliasOf, path);
  const scoped = touches.filter((t) => resolveCanonicalPath(aliasOf, t.path) === target);
  return computeChurn(scoped, botGlobs);
}

/** person grain: churn attributed to a single author. */
export function computePersonChurn(
  touches: readonly ChurnFileTouch[],
  authorLogin: string,
  botGlobs?: readonly string[],
): ChurnResult {
  return computeChurn(
    touches.filter((t) => t.authorLogin === authorLogin),
    botGlobs,
  );
}
