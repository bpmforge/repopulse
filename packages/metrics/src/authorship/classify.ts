import { isBotLogin } from '../engine/bots.js';
import { AI_TRAILER_KEYS, type AiAuthorshipPatterns } from './patterns.js';
import { splitTrailer } from './trailers.js';

// The authorship classifier (W18-20). Pure: the readers hand it warehouse rows,
// it hands back a cohort and the signal that decided it.
//
// FOUR COHORTS, not two. `automation` (dependabot, renovate — bots that are
// not coding agents) is neither human nor AI-authored work and would skew both
// sides; `unknown` is a change ingested before the trailer and branch columns
// existed (migration 0035), which cannot honestly be called human just because
// nothing says otherwise. Both are reported as counts and excluded from the
// comparison.

export type Authorship = 'ai' | 'human' | 'automation' | 'unknown';

/** What decided an `ai` verdict — reported in aggregate so a reader can see what the number rests on. */
export type AiSignal = 'trailer' | 'bot_author' | 'branch_prefix' | 'linked_pr' | 'linked_commit';

export interface AuthorshipVerdict {
  authorship: Authorship;
  signal: AiSignal | null;
}

/** A single `*` wildcard anywhere, case-insensitive — the same shape as the bot-login globs. */
function globMatch(glob: string, value: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export function isAgentLogin(login: string, patterns: AiAuthorshipPatterns): boolean {
  return login !== '' && patterns.botLogins.some((g) => globMatch(g, login));
}

export function hasAiTrailer(
  trailers: readonly string[] | null,
  patterns: AiAuthorshipPatterns,
): boolean {
  if (!trailers || patterns.trailerPatterns.length === 0) return false;
  const needles = patterns.trailerPatterns.map((p) => p.toLowerCase());
  return trailers.some((t) => {
    const parsed = splitTrailer(t);
    if (!parsed || !AI_TRAILER_KEYS.includes(parsed.key)) return false;
    const value = parsed.value.toLowerCase();
    return needles.some((n) => value.includes(n));
  });
}

export function hasAgentBranch(headRef: string | null, patterns: AiAuthorshipPatterns): boolean {
  if (!headRef) return false;
  const ref = headRef.toLowerCase();
  return patterns.branchPrefixes.some((p) => ref.startsWith(p.toLowerCase()));
}

export interface CommitAuthorshipInput {
  authorLogin: string;
  /** NULL = ingested before 0035; the message was never parsed. */
  trailers: readonly string[] | null;
  /** The verdict of the PR this commit landed through, when one is linked. */
  linkedPr?: AuthorshipVerdict | null;
}

/**
 * A commit's authorship. Order is strongest evidence first: an agent's own
 * account, then an explicit co-author trailer, then the PR it came through.
 */
export function classifyCommit(
  c: CommitAuthorshipInput,
  patterns: AiAuthorshipPatterns,
  automationGlobs: readonly string[],
): AuthorshipVerdict {
  if (isAgentLogin(c.authorLogin, patterns)) return { authorship: 'ai', signal: 'bot_author' };
  if (hasAiTrailer(c.trailers, patterns)) return { authorship: 'ai', signal: 'trailer' };
  if (c.linkedPr?.authorship === 'ai') return { authorship: 'ai', signal: 'linked_pr' };
  // AFTER the agent checks: `*[bot]` in the default automation globs would
  // otherwise swallow claude[bot] and copilot-swe-agent[bot] as dependabots.
  if (isBotLogin(c.authorLogin, automationGlobs)) return { authorship: 'automation', signal: null };
  if (c.trailers === null) return { authorship: 'unknown', signal: null };
  return { authorship: 'human', signal: null };
}

export interface PrAuthorshipInput {
  authorLogin: string;
  isBot: boolean;
  /** NULL = ingested before 0035 or not reported by the forge. */
  headRef: string | null;
  /** True when a commit linked to this PR carries an AI trailer (a squash keeps them). */
  linkedCommitHasAiTrailer?: boolean;
}

export function classifyPr(
  p: PrAuthorshipInput,
  patterns: AiAuthorshipPatterns,
  automationGlobs: readonly string[],
): AuthorshipVerdict {
  if (isAgentLogin(p.authorLogin, patterns)) return { authorship: 'ai', signal: 'bot_author' };
  if (hasAgentBranch(p.headRef, patterns)) return { authorship: 'ai', signal: 'branch_prefix' };
  if (p.linkedCommitHasAiTrailer) return { authorship: 'ai', signal: 'linked_commit' };
  if (p.isBot || isBotLogin(p.authorLogin, automationGlobs)) {
    return { authorship: 'automation', signal: null };
  }
  if (p.headRef === null) return { authorship: 'unknown', signal: null };
  return { authorship: 'human', signal: null };
}

/**
 * The PR number a squash or merge commit names in its subject — "Fix x (#123)"
 * on GitHub and Gitea. A heuristic link, used only to carry a PR's branch-prefix
 * verdict onto the commit that landed it; a subject without the suffix links
 * nothing rather than guessing.
 */
export function prNumberFromSubject(subject: string): number | null {
  const m = /\(#(\d{1,9})\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}
