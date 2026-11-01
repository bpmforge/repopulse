import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, ne } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { latestBaseRun, toolsMatch, type BaseRun } from './input-hash.js';

// Incremental scans (W23-03, INCREMENTAL_SCAN_PLAN WP-R3, claim C12).
//
// For a scanner that judges each file on its own (a linter, a pattern engine),
// a new commit only changes the answer for the files the commit changed. This
// decides whether the work can be limited to those files, and says which they
// are; the scanner then scans just them and `carryForward` (packages/insights)
// merges the base run's findings for the rest. The RESULT is still the whole
// tree's; only the WORK is smaller (C12).
//
// WHEN IT SAYS "FULL". Every one of these is a redundant full scan at worst,
// never a stale answer:
//   - the forge cannot compare (no op, a refusal, a base it no longer has);
//   - the comparison is truncated, or longer than the scanner's own cap;
//   - there is no earlier real run, or it ran other tools / other data;
//   - DRIFT GUARD: `maxChain` incrementals have run since the last full, or that
//     full is older than `maxAgeDays`, or no full is on record. A merge that is
//     wrong in some way nobody noticed cannot compound for longer than that.
//
// The framework never branches on a scanner key: the caller passes the key and
// the scanner's own cap (registry metadata `Scanner.incremental`) as data.

export const DEFAULT_MAX_CHAIN = 10;
export const DEFAULT_MAX_AGE_DAYS = 30;

const SCAN_LANE = (repoId: number): CallCtx => ({ lane: 'scan', repoId: String(repoId) });

export type IncrementalPlan =
  | {
      mode: 'full';
      /** Why the work could not be limited — for the log, never a branch. */
      reason: string;
    }
  | {
      mode: 'incremental';
      baseRun: BaseRun;
      /** Files added or modified in the delta (a rename's NEW path is here). */
      changed: string[];
      /** Files removed in the delta (a rename's OLD path is here). */
      deleted: string[];
    };

export interface PlanIncrementalArgs {
  db: Database;
  provider: ForgeProvider;
  /** The forge's full name (`org/name`). */
  repo: string;
  workspaceId: number;
  repoId: number;
  scannerKey: string;
  headSha: string;
  /** Tools this run would stamp; undefined = the scanner learns them only by running. */
  toolVersions?: Record<string, string> | null;
  /**
   * The data stamp this run would carry. A string must equal the base run's;
   * null = "unreadable now", which cannot vouch for anything and plans FULL;
   * undefined = the scanner depends on no such data.
   */
  dataVersion?: string | null;
  /** The scanner's own ceiling (registry metadata `incremental.maxChangedFiles`). */
  maxChangedFiles: number;
  maxChain?: number;
  maxAgeDays?: number;
  now?: Date;
}

const full = (reason: string): IncrementalPlan => ({ mode: 'full', reason });

/**
 * The newest real runs for one scanner, newest first — the same filter as
 * `latestBaseRun` (succeeded, whole, not a skipped restatement, not a PR look),
 * with the columns the drift guard needs. Tenancy re-applied in memory.
 */
async function recentRealRuns(
  db: Database,
  q: { workspaceId: number; repoId: number; scannerKey: string },
  limit: number,
) {
  const rows = await db
    .select({
      id: security.scanRuns.id,
      workspaceId: security.scanRuns.workspaceId,
      repoId: security.scanRuns.repoId,
      scannerKey: security.scanRuns.scannerKey,
      status: security.scanRuns.status,
      partial: security.scanRuns.partial,
      scope: security.scanRuns.scope,
      trigger: security.scanRuns.trigger,
      startedAt: security.scanRuns.startedAt,
      finishedAt: security.scanRuns.finishedAt,
    })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, q.workspaceId),
        eq(security.scanRuns.repoId, q.repoId),
        eq(security.scanRuns.scannerKey, q.scannerKey),
        eq(security.scanRuns.status, 'succeeded'),
        eq(security.scanRuns.partial, false),
        ne(security.scanRuns.scope, 'skipped'),
        ne(security.scanRuns.trigger, 'pr_synced'),
      ),
    )
    .orderBy(desc(security.scanRuns.id))
    .limit(limit);
  return rows.filter(
    (r) =>
      r.workspaceId === q.workspaceId &&
      r.repoId === q.repoId &&
      r.scannerKey === q.scannerKey &&
      r.status === 'succeeded' &&
      !r.partial &&
      r.scope !== 'skipped' &&
      r.trigger !== 'pr_synced',
  );
}

/** Split a comparison into the paths to scan and the paths that are gone. */
export function splitComparison(
  files: readonly { path: string; status: string; previousPath?: string }[],
): { changed: string[]; deleted: string[] } {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const f of files) {
    if (f.status === 'removed') deleted.add(f.path);
    else {
      changed.add(f.path);
      // A rename is the old path going away and a new one appearing.
      if (f.status === 'renamed' && f.previousPath) deleted.add(f.previousPath);
    }
  }
  // A path that exists at the head is not gone, whatever else moved through it.
  for (const p of changed) deleted.delete(p);
  return { changed: [...changed].sort(), deleted: [...deleted].sort() };
}

export async function planIncremental(a: PlanIncrementalArgs): Promise<IncrementalPlan> {
  const maxChain = a.maxChain ?? DEFAULT_MAX_CHAIN;
  const maxAgeDays = a.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const now = a.now ?? new Date();
  const compare = a.provider.compareCommits;
  if (typeof compare !== 'function') return full('forge_cannot_compare');
  if (a.headSha === '') return full('no_head');
  if (a.dataVersion === null) return full('data_version_unreadable');

  const q = { workspaceId: a.workspaceId, repoId: a.repoId, scannerKey: a.scannerKey };
  const base = await latestBaseRun(a.db, q);
  if (base === null) return full('no_base_run');
  if (!toolsMatch(base, a.toolVersions)) return full('tool_versions_changed');
  if (a.dataVersion !== undefined && base.dataVersion !== a.dataVersion) {
    return full('data_version_changed');
  }

  // DRIFT GUARD. Walk back over the real runs: incrementals until the first full.
  const runs = await recentRealRuns(a.db, q, maxChain + 5);
  let chained = 0;
  let lastFull: (typeof runs)[number] | undefined;
  for (const run of runs) {
    if (run.scope === 'full') {
      lastFull = run;
      break;
    }
    chained += 1;
  }
  if (lastFull === undefined) return full('no_full_run_on_record');
  if (chained >= maxChain) return full('chain_limit');
  const fullAt = lastFull.finishedAt ?? lastFull.startedAt;
  if (now.getTime() - fullAt.getTime() > maxAgeDays * 86_400_000) return full('last_full_too_old');

  let comparison;
  try {
    comparison = await compare.call(
      a.provider,
      SCAN_LANE(a.repoId),
      a.repo,
      base.commitSha,
      a.headSha,
    );
  } catch {
    // A forge that cannot answer (404 for a base it no longer has, a budget park)
    // is the full scan's problem to solve, not this one's.
    return full('compare_unavailable');
  }
  if (comparison.truncated) return full('compare_truncated');
  if (comparison.files.length > a.maxChangedFiles) return full('over_cap');

  const { changed, deleted } = splitComparison(comparison.files);
  return { mode: 'incremental', baseRun: base, changed, deleted };
}

// ---- fetching only the changed files -----------------------------------------

export interface FetchFilesArgs {
  provider: ForgeProvider;
  repo: string;
  repoId: number;
  commitSha: string;
  paths: readonly string[];
  /** Scratch directory the files are written under, mirroring their repo paths. */
  root: string;
  /** Hard cap on files fetched; the rest are not read and not listed as written. */
  maxFiles?: number;
  /**
   * What to do when the forge says a file is not there at the head. 'throw' is
   * the PR path's long-standing behaviour; 'skip' lists it under `gone`.
   */
  onMissing?: 'throw' | 'skip';
}

export interface FetchedFiles {
  /** Repo-relative paths written under `root`: the files that were actually read. */
  written: string[];
  /** Present but with no content (over the forge's size limit, or binary). */
  unreadable: string[];
  /** Not there at the head (only with onMissing 'skip'). */
  gone: string[];
  /** Paths past `maxFiles` that were never requested. */
  overCap: string[];
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

/**
 * One budgeted contents call per file (Law 7; never the tarball, never a raw
 * fetch), written into a scratch dir. This is the fetch the PR semgrep path has
 * always used, lifted out so the incremental modes share it.
 *
 * A file with no content is NEVER written empty: an empty file scans clean and
 * would count as coverage it never had. A path that would land outside `root`
 * (a forge-supplied `..`) is skipped as unreadable.
 */
export async function fetchChangedFiles(a: FetchFilesArgs): Promise<FetchedFiles> {
  const ctx = SCAN_LANE(a.repoId);
  const out: FetchedFiles = { written: [], unreadable: [], gone: [], overCap: [] };
  const limit = a.maxFiles ?? Number.POSITIVE_INFINITY;
  const rootResolved = path.resolve(a.root);
  for (const file of a.paths) {
    if (out.written.length + out.unreadable.length + out.gone.length >= limit) {
      out.overCap.push(file);
      continue;
    }
    const target = path.resolve(rootResolved, file);
    if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) {
      out.unreadable.push(file);
      continue;
    }
    let content: string | null;
    try {
      content = (await a.provider.getFileContent(ctx, a.repo, file, a.commitSha)).content;
    } catch (err) {
      if (a.onMissing === 'skip' && isNotFound(err)) {
        out.gone.push(file);
        continue;
      }
      throw err;
    }
    if (content === null) {
      out.unreadable.push(file);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o600 });
    out.written.push(file);
  }
  return out;
}
