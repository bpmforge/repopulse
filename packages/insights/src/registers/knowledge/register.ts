import { and, eq, gte, sql } from 'drizzle-orm';
import { facts, type Database } from '@repopulse/shared';

// Knowledge-concentration register (W10-01, FR-REG-1, D13).
//
// A module only one person has touched in six months is a risk the same way an
// unpatched dependency is: it is fine until the day it is not, and the day it
// is not is usually someone's notice period.
//
// N-9 IS THE HARD CONSTRAINT HERE, and it shapes the whole module: this
// produces COUNTS AND SHARES, never people. No login, no name, no email
// reaches a finding — not in the title, not in the evidence, not in the
// recommendation. A "bus factor" finding that names the person is a
// leaderboard with a safety-flavoured excuse, and NON_GOALS N-9 rejects it at
// review. A test greps every payload for identity fields.
//
// It is also pure warehouse SQL. No forge call, no model: the answer is in the
// commits we already have.

export const KNOWLEDGE_WINDOW_DAYS = 180;

export interface KnowledgeThresholds {
  /** At or below this many active maintainers, the module is concentrated. */
  maxMaintainers: number;
  /** At or above this share for the top contributor, likewise. */
  minTopShare: number;
  /** Modules with fewer changed lines than this are too quiet to judge. */
  minLines: number;
}

export const KNOWLEDGE_DEFAULTS: KnowledgeThresholds = {
  maxMaintainers: 2,
  minTopShare: 0.8,
  // A module touched twice in six months has a bus factor of one in the same
  // way an empty room has a fire risk of zero. Below this it is noise.
  minLines: 200,
};

export interface ModuleConcentration {
  /** Directory path — the module, not the file. */
  module: string;
  maintainers: number;
  /** Share of changed lines from the single largest contributor, 0-1. */
  topShare: number;
  totalLines: number;
}

/** Directory of a path, one level deep from the repo root by default. */
export function moduleOf(path: string, depth = 2): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '(root)';
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}

/**
 * Concentration per module, over the window.
 *
 * The identity join is INSIDE this function and its output carries none of it:
 * the query needs to know who authored what in order to count distinct
 * authors, and the boundary where that stops being true is exactly here.
 */
export async function moduleConcentration(
  db: Database,
  repoId: number,
  windowStart: Date,
  depth = 2,
): Promise<ModuleConcentration[]> {
  const rows = await db
    .select({
      path: facts.commitFiles.path,
      authorIdentityId: facts.commits.authorIdentityId,
      lines: sql<number>`sum(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
    })
    .from(facts.commitFiles)
    .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
    .where(
      and(
        eq(facts.commits.repoId, repoId),
        gte(facts.commits.authoredAt, windowStart),
        // Merges carry no authorship signal about the code itself (§0).
        eq(facts.commits.isMerge, false),
      ),
    )
    .groupBy(facts.commitFiles.path, facts.commits.authorIdentityId);

  // Fold to modules in memory: the grouping key is a path prefix, and doing it
  // in SQL would bake the module depth into the query.
  const byModule = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const module = moduleOf(row.path, depth);
    const authors = byModule.get(module) ?? new Map<number, number>();
    authors.set(row.authorIdentityId, (authors.get(row.authorIdentityId) ?? 0) + row.lines);
    byModule.set(module, authors);
  }

  const out: ModuleConcentration[] = [];
  for (const [module, authors] of byModule) {
    const lines = [...authors.values()];
    const totalLines = lines.reduce((sum, n) => sum + n, 0);
    if (totalLines === 0) continue;
    out.push({
      module,
      maintainers: authors.size,
      topShare: Math.max(...lines) / totalLines,
      totalLines,
    });
  }
  return out.sort((a, b) => b.totalLines - a.totalLines);
}

export interface KnowledgeFinding {
  dimension: 'knowledge';
  module: string;
  severity: number;
  title: string;
  evidence: string;
  recommendation: string;
  maintainers: number;
  topShare: number;
  totalLines: number;
}

/**
 * Findings from concentration, with thresholds applied.
 *
 * BOTH conditions must hold. Few maintainers alone catches every small module;
 * a high top share alone catches every module with one enthusiastic owner and
 * four occasional ones — which is not a bus factor, it is a maintainer.
 */
export function knowledgeFindings(
  modules: readonly ModuleConcentration[],
  thresholds: KnowledgeThresholds = KNOWLEDGE_DEFAULTS,
): KnowledgeFinding[] {
  const out: KnowledgeFinding[] = [];

  for (const module of modules) {
    if (module.totalLines < thresholds.minLines) continue;
    if (module.maintainers > thresholds.maxMaintainers) continue;
    if (module.topShare < thresholds.minTopShare) continue;

    // Severity from how concentrated it is, capped at 3: this is a staffing
    // risk, not an exploit, and a bus-factor finding outranking a live
    // vulnerability would be a mis-sorted list.
    const severity = module.maintainers <= 1 ? 3 : 2;

    out.push({
      dimension: 'knowledge',
      module: module.module,
      severity,
      // COUNTS AND SHARES ONLY (N-9). Every string below is checked by a test
      // for identity fields — the moment one names a person, this stops being
      // a risk register and becomes a leaderboard.
      title: `Knowledge concentrated in ${module.module}`,
      evidence: `${module.maintainers} active contributor(s) over ${KNOWLEDGE_WINDOW_DAYS} days; the largest single share is ${Math.round(module.topShare * 100)}% of ${module.totalLines} changed lines`,
      recommendation:
        'Pair or rotate a second maintainer through this module. The aim is a second person who can review changes here confidently — not a reassignment.',
      maintainers: module.maintainers,
      topShare: Math.round(module.topShare * 1000) / 1000,
      totalLines: module.totalLines,
    });
  }

  return out;
}

/** Identity-shaped fields that must never appear in a payload (N-9). */
export const FORBIDDEN_IDENTITY_KEYS = [
  'login',
  'name',
  'email',
  'author',
  'username',
  'handle',
  'identityId',
];
