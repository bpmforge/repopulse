import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { core, facts, type Database } from '@repopulse/shared';
import type { CallCtx, ForgeComparison, ForgeDiffFile, ForgeProvider } from '@repopulse/forge';
import { AI_PASS_MAX_BYTES, AI_PASS_MAX_FILES, type AiPassDeps } from './ai-pass-processor.js';

// Where a DIFF-mode AI pass gets its changes (W19-11): a pull request's files or
// the files of a short range of commits, through the budgeted forge client on the
// scan lane (C1: no clone, no archive). Read-only (D9a): nothing is written to the
// forge and the web app never calls it.
//
// BOUNDED, not truncated. Over the file or byte cap, or a range of too many
// commits, the pass is refused with a sentence; a file whose patch the forge
// omitted or clipped is LISTED as unreadable, never silently reviewed in part.

/** Most commits one range pass will review, one commit at a time. */
export const AI_PASS_MAX_COMMITS = 10;
/** Most forge pages read for one pull request or commit. */
const MAX_PAGES = 12;

export interface DiffEntry {
  path: string;
  patch: string;
}

export type LoadedDiff =
  | {
      ok: true;
      /** The head commit reviewed. */
      commitSha: string;
      baseRef: string;
      headRef: string;
      /** Human label for the model's prompt, e.g. "Pull request #12: Add refunds". */
      title: string;
      files: DiffEntry[];
      /** Changed files whose patch the forge did not supply in full. */
      unreadable: string[];
      /** Commits reviewed, oldest first (range mode). */
      commits?: string[];
    }
  | { ok: false; code: string; reason: string };

export interface DiffRequest {
  workspaceId: number;
  repoId: number;
  mode: 'pull_request' | 'commit_range';
  prNumber?: number | null;
  base?: string | null;
  head?: string | null;
}

/**
 * The NEW-side line ranges a unified patch adds or changes, as inclusive
 * [start, end] pairs. A finding "falls inside the diff" when its lines overlap
 * one of these.
 */
export function addedRanges(patch: string): [number, number][] {
  const ranges: [number, number][] = [];
  let line = 0;
  let open: number | null = null;
  const close = () => {
    if (open !== null) ranges.push([open, line - 1]);
    open = null;
  };
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      close();
      line = Number(hunk[1]);
      continue;
    }
    if (line === 0) continue; // before the first hunk header
    if (text.startsWith('+') && !text.startsWith('+++')) {
      open ??= line;
      line += 1;
    } else if (text.startsWith('-') || text.startsWith('\\')) {
      close(); // a removed line or "\ No newline" does not advance the new side
    } else {
      close();
      line += 1; // context line
    }
  }
  close();
  return ranges;
}

/** True when [start, end] overlaps any range. */
export function overlaps(ranges: readonly [number, number][], start: number, end: number): boolean {
  return ranges.some(([a, b]) => start <= b && end >= a);
}

/** Per file, every range its diff entries add (a range pass may touch a file twice). */
export function rangesByFile(files: readonly DiffEntry[]): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  for (const f of files) {
    const list = out.get(f.path) ?? [];
    list.push(...addedRanges(f.patch));
    out.set(f.path, list);
  }
  return out;
}

export interface ForgeDiffDeps {
  db: Database;
  forgeFor: (
    workspaceId: number,
    repoId: number,
  ) => Promise<{ provider: ForgeProvider; repoFullName: string } | null>;
}

const SHA = /^[0-9a-f]{7,64}$/i;

export function forgeDiffSources(deps: ForgeDiffDeps): NonNullable<AiPassDeps['loadDiff']> {
  return async (req) => {
    const { db } = deps;
    // The repository must belong to the workspace asking (Law 5).
    const [repo] = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.id, req.repoId), eq(core.repos.workspaceId, req.workspaceId)))
      .limit(1);
    if (!repo)
      return { ok: false, code: 'not_found', reason: 'No such repository in this workspace.' };

    const forge = await deps.forgeFor(req.workspaceId, req.repoId);
    if (!forge) {
      return {
        ok: false,
        code: 'no_connection',
        reason: 'This repository has no active forge connection, so its changes cannot be read.',
      };
    }
    const ctx: CallCtx = { lane: 'scan', repoId: String(req.repoId) };
    const collected: { entry: DiffEntry }[] = [];
    const unreadable: string[] = [];

    const take = (files: ForgeDiffFile[]) => {
      for (const f of files) {
        if (f.status === 'removed') continue; // nothing on the new side to review
        if (f.patch === undefined || f.patch === '' || f.patchTruncated) {
          unreadable.push(f.path);
          continue;
        }
        collected.push({ entry: { path: f.path, patch: f.patch } });
      }
    };

    let commitSha: string;
    let baseRef: string;
    let headRef: string;
    let title: string;
    let commits: string[] | undefined;

    if (req.mode === 'pull_request') {
      const [pr] = await db
        .select({
          title: facts.pullRequests.title,
          baseRef: facts.pullRequests.baseRef,
          headSha: facts.pullRequests.headSha,
        })
        .from(facts.pullRequests)
        .where(
          and(
            eq(facts.pullRequests.workspaceId, req.workspaceId),
            eq(facts.pullRequests.repoId, req.repoId),
            eq(facts.pullRequests.number, req.prNumber ?? -1),
          ),
        )
        .limit(1);
      if (!pr) {
        return {
          ok: false,
          code: 'not_found',
          reason: `Pull request #${req.prNumber} has not been ingested for this repository.`,
        };
      }
      commitSha = pr.headSha;
      baseRef = pr.baseRef;
      headRef = pr.headSha;
      title = `Pull request #${req.prNumber}: ${pr.title}`;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await forge.provider.getPullRequestFiles(
          ctx,
          forge.repoFullName,
          req.prNumber!,
          cursor,
        );
        take(res.items);
        cursor = res.nextCursor;
        // Stop reading once the cap is already blown: the answer is "too large".
        if (cursor === undefined || collected.length > AI_PASS_MAX_FILES) break;
      }
    } else {
      const base = (req.base ?? '').toLowerCase();
      const head = (req.head ?? '').toLowerCase();
      if (!SHA.test(base) || !SHA.test(head)) {
        return {
          ok: false,
          code: 'bad_range',
          reason: 'A commit range needs a base and a head commit id (at least 7 hex characters).',
        };
      }
      const find = async (sha: string) => {
        const rows = await db
          .select({ sha: facts.commits.sha, committedAt: facts.commits.committedAt })
          .from(facts.commits)
          .where(
            and(
              eq(facts.commits.workspaceId, req.workspaceId),
              eq(facts.commits.repoId, req.repoId),
              sql`${facts.commits.sha} like ${sha + '%'}`,
            ),
          )
          .limit(2);
        return rows.length === 1 ? rows[0]! : null;
      };
      const [b, h] = [await find(base), await find(head)];
      if (!b || !h) {
        return {
          ok: false,
          code: 'not_found',
          reason: `${!b ? base : head} is not an ingested commit of this repository (or its id is ambiguous).`,
        };
      }
      if (h.committedAt <= b.committedAt) {
        return {
          ok: false,
          code: 'bad_range',
          reason: 'The head commit must be newer than the base commit.',
        };
      }
      // The commits we have ingested after the base up to and including the head,
      // oldest first, merges skipped. We keep no parent graph, so this is the
      // time-ordered set - said so on the screen.
      const inRange = await db
        .select({ sha: facts.commits.sha })
        .from(facts.commits)
        .where(
          and(
            eq(facts.commits.workspaceId, req.workspaceId),
            eq(facts.commits.repoId, req.repoId),
            gt(facts.commits.committedAt, b.committedAt),
            lte(facts.commits.committedAt, h.committedAt),
            eq(facts.commits.isMerge, false),
          ),
        )
        .orderBy(asc(facts.commits.committedAt))
        .limit(AI_PASS_MAX_COMMITS + 1);
      if (inRange.length > AI_PASS_MAX_COMMITS) {
        return {
          ok: false,
          code: 'too_large',
          reason: `That range has more than ${AI_PASS_MAX_COMMITS} commits; a pass reviews at most ${AI_PASS_MAX_COMMITS}. Pick a closer base.`,
        };
      }
      if (inRange.length === 0) {
        return {
          ok: false,
          code: 'no_files',
          reason: 'No non-merge commit lies between those two commits.',
        };
      }
      commitSha = h.sha;
      baseRef = b.sha;
      headRef = h.sha;
      commits = inRange.map((c) => c.sha);
      title = `Commits ${b.sha.slice(0, 8)}..${h.sha.slice(0, 8)} (${commits.length})`;
      outer: for (const sha of commits) {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await forge.provider.getCommitFiles(ctx, forge.repoFullName, sha, cursor);
          take(res.items);
          cursor = res.nextCursor;
          if (collected.length > AI_PASS_MAX_FILES) break outer;
          if (cursor === undefined) break;
        }
      }
    }

    if (collected.length === 0) {
      return {
        ok: false,
        code: 'no_files',
        reason:
          unreadable.length > 0
            ? `None of the ${unreadable.length} changed file${unreadable.length === 1 ? '' : 's'} came with a complete patch from the forge (${unreadable.slice(0, 5).join(', ')}), so there was nothing to review.`
            : 'The change contains no reviewable file: it only removes files, or is empty.',
      };
    }
    const bytes = collected.reduce((n, c) => n + Buffer.byteLength(c.entry.patch), 0);
    if (collected.length > AI_PASS_MAX_FILES || bytes > AI_PASS_MAX_BYTES) {
      return {
        ok: false,
        code: 'too_large',
        reason: `That change is ${collected.length > AI_PASS_MAX_FILES ? `more than ${AI_PASS_MAX_FILES}` : collected.length} files and ${Math.round(bytes / 1024)} KB of diff; a pass reviews at most ${AI_PASS_MAX_FILES} files and ${Math.round(AI_PASS_MAX_BYTES / 1024)} KB. Review a smaller pull request or a closer commit range.`,
      };
    }
    return {
      ok: true,
      commitSha,
      baseRef,
      headRef,
      title,
      files: collected.map((c) => c.entry),
      unreadable,
      ...(commits ? { commits } : {}),
    };
  };
}

/**
 * W23-07: the files that differ between two heads of a pull request, for an
 * incremental re-review. The compare call lives HERE, in the worker, through the
 * budgeted client on the scan lane (Law 7); analysis never calls the forge and
 * receives only the file list. null = unavailable (the forge cannot compare, or
 * refused it - an unknown base after a force push is a 404 - or the repo has no
 * connection): the caller reviews in full.
 */
export function forgeCompareHeads(
  deps: ForgeDiffDeps,
): (req: { workspaceId: number; repoId: number; base: string; head: string }) => Promise<ForgeComparison | null> {
  return async (req) => {
    const [repo] = await deps.db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.id, req.repoId), eq(core.repos.workspaceId, req.workspaceId)))
      .limit(1);
    if (!repo) return null;
    const forge = await deps.forgeFor(req.workspaceId, req.repoId);
    if (!forge || typeof forge.provider.compareCommits !== 'function') return null;
    try {
      return await forge.provider.compareCommits(
        { lane: 'scan', repoId: String(req.repoId) },
        forge.repoFullName,
        req.base,
        req.head,
      );
    } catch {
      return null;
    }
  };
}
