import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { core, facts, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { readSnapshotSources, snapshotForScan } from '@repopulse/security';
import { isTestPath } from './code-kind.js';
import {
  AI_PASS_MAX_BYTES,
  AI_PASS_MAX_FILES,
  inScope,
  type AiPassDeps,
} from './ai-pass-processor.js';

// Where an AI pass gets its files (W19-09): the repository's archive at its head
// commit, read through the same scan-lane forge config as every scanner and ONLY
// read (D9a). The web app never calls a forge; only this worker does, and only to
// fetch an archive it then deletes (C1a).
//
// BOUNDED, not truncated. A pass over more than AI_PASS_MAX_FILES files, or more
// than AI_PASS_MAX_BYTES, is refused with a sentence telling the person to name a
// smaller scope - silently reviewing "the first forty" would read as a clean pass.

/**
 * The file types an AI pass reads (W20-16, UX_TODO AI-85). Wider than the
 * deterministic scanners' list: a model can review a Vue component, a Swift
 * file or a Terraform module even though no rule here can. Kept in step with
 * READABLE_SOURCES in apps/web/src/widgets/repo/AiPassPanel.tsx.
 */
export const AI_PASS_READABLE =
  /(\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|go|rb|java|kt|kts|scala|cs|php|rs|swift|c|h|cc|cpp|cxx|hpp|m|mm|dart|ex|exs|sh|bash|tf|hcl|ya?ml|sql)|^go\.mod)$/;

/** Upper bound on files WALKED for one pass (the read cap is AI_PASS_MAX_FILES). */
const AI_PASS_WALK_FILES = 5000;

/** Directory `rel` is on the way to, or inside, one of the named paths. */
export function dirInScope(rel: string, paths: readonly string[]): boolean {
  return paths.some((p) => {
    const norm = p.replace(/\/+$/, '');
    return norm === rel || norm.startsWith(`${rel}/`) || rel.startsWith(`${norm}/`);
  });
}

/**
 * W25-01: the best-ranked files that fit one pass (AI_PASS_MAX_FILES files and
 * AI_PASS_MAX_BYTES), in the order of `ranked`. A file too big for what is left
 * is passed over for a smaller one further down, never cut.
 */
export function fitRanked<T extends { path: string; source: string }>(
  files: readonly T[],
  ranked: readonly string[],
  caps: { files: number; bytes: number } = { files: AI_PASS_MAX_FILES, bytes: AI_PASS_MAX_BYTES },
): T[] {
  const rank = new Map(ranked.map((p, i) => [p.replace(/\/+$/, ''), i]));
  const ordered = [...files].sort(
    (a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity),
  );
  const chosen: T[] = [];
  let used = 0;
  for (const f of ordered) {
    if (chosen.length >= caps.files) break;
    const size = Buffer.byteLength(f.source);
    if (used + size > caps.bytes) continue;
    chosen.push(f);
    used += size;
  }
  return chosen;
}

/**
 * W25-16: the walk filter for a pass over `paths`. Test code is left out of a
 * folder review unless the person asked for it (Include tests) or named a test
 * path themselves; a file named outright is always read. The readable test
 * files left out are collected: they still exist, so the processor must not
 * treat them as deleted.
 */
export function passScope(
  paths: readonly string[],
  includeTests: boolean,
): { include: (rel: string, isDir: boolean) => boolean; leftOut: string[] } {
  // A named folder counts as a test path too ("src/__tests__" with no slash).
  const skipTests =
    !includeTests && !paths.some((p) => isTestPath(p) || isTestPath(`${p.replace(/\/+$/, '')}/`));
  const leftOut: string[] = [];
  return {
    leftOut,
    include: (rel, isDir) => {
      if (isDir) return dirInScope(rel, paths);
      if (!inScope(rel, paths)) return false;
      if (skipTests && isTestPath(rel) && !paths.includes(rel)) {
        if (AI_PASS_READABLE.test(path.basename(rel))) leftOut.push(rel);
        return false;
      }
      return true;
    },
  };
}

export interface SnapshotSourceDeps {
  db: Database;
  forgeFor: (
    workspaceId: number,
    repoId: number,
  ) => Promise<{ provider: ForgeProvider; repoFullName: string } | null>;
}

export function snapshotSources(deps: SnapshotSourceDeps): AiPassDeps['loadSources'] {
  return async ({ workspaceId, repoId, paths, fit, includeTests }) => {
    // The repository must belong to the workspace asking (Law 5).
    const [repo] = await deps.db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
      .limit(1);
    if (!repo)
      return { ok: false, code: 'not_found', reason: 'No such repository in this workspace.' };

    const forge = await deps.forgeFor(workspaceId, repoId);
    if (!forge) {
      return {
        ok: false,
        code: 'no_connection',
        reason: 'This repository has no active forge connection, so its files cannot be read.',
      };
    }
    if (!forge.provider.capabilities.supportsTarball) {
      return {
        ok: false,
        code: 'no_snapshot',
        reason: `The ${forge.provider.kind} forge cannot supply an archive of the repository, and a pass will not fetch files one by one.`,
      };
    }
    const [head] = await deps.db
      .select({ sha: facts.commits.sha })
      .from(facts.commits)
      .where(eq(facts.commits.repoId, repoId))
      .orderBy(desc(facts.commits.committedAt))
      .limit(1);
    if (!head?.sha) {
      return {
        ok: false,
        code: 'no_head_sha',
        reason: 'No commit has been ingested for this repository yet.',
      };
    }

    return snapshotForScan(
      { provider: forge.provider, repo: forge.repoFullName, commitSha: head.sha },
      async (snapshot) => {
        // W20-16 (UX_TODO AI-85): walk ONLY the named paths. Walking the
        // whole tree and filtering after meant a folder that sorted after the
        // first 5,000 files of a monorepo was "not found".
        const scope = passScope(paths, includeTests === true);
        const leftOutTests = scope.leftOut;
        const all = readSnapshotSources(snapshot.dir, {
          maxFiles: AI_PASS_WALK_FILES,
          readable: AI_PASS_READABLE,
          include: scope.include,
        });
        const picked = all.files;
        const testsNote = leftOutTests.length > 0 ? { tests: leftOutTests.length } : {};
        const at = head.sha.slice(0, 8);
        if (all.truncated) {
          return {
            ok: false as const,
            code: 'too_large',
            reason: `Those paths hold more than ${AI_PASS_WALK_FILES} files at ${at}, so the pass stopped walking them rather than review part of what you asked for. Name a smaller directory or specific files.`,
          };
        }
        if (picked.length === 0) {
          // Say WHY, not "no match": a path that exists but holds only file
          // types the pass does not read, or only files over the size cap, is
          // a different answer from a path that is not there.
          const missing = paths.filter(
            (p) => !existsSync(path.join(snapshot.dir, p.replace(/\/+$/, ''))),
          );
          const named = paths.filter((p) => !missing.includes(p));
          const singleFile =
            named.length === 1 && statSync(path.join(snapshot.dir, named[0]!)).isFile();
          let reason: string;
          if (named.length === 0) {
            reason = `None of the paths (${paths.join(', ')}) exist at ${at}. Paths are relative to the repository root.`;
          } else if (leftOutTests.length > 0) {
            reason = `${named.join(', ')} ${named.length === 1 ? 'holds' : 'hold'} only test code at ${at} (${leftOutTests.length} ${leftOutTests.length === 1 ? 'file' : 'files'}), which a review leaves out. Tick Include tests to review it.`;
          } else if (all.unsupported > 0 && all.tooLarge.length === 0) {
            reason = singleFile
              ? `${named[0]} exists at ${at}, but the pass does not read that file type.`
              : `${named.join(', ')} ${named.length === 1 ? 'exists' : 'exist'} at ${at}, but ${all.unsupported === 1 ? 'the one file there is' : `all ${all.unsupported} files there are`} of types the pass does not read (for example ${all.unsupportedExamples[0]}).`;
          } else if (all.tooLarge.length > 0) {
            reason = `Every readable file under ${named.join(', ')} at ${at} is over 512 KB (for example ${all.tooLarge[0]}), and the pass skips files that large.`;
          } else {
            reason = `${named.join(', ')} ${named.length === 1 ? 'holds' : 'hold'} no files at ${at}.`;
          }
          if (missing.length > 0 && named.length > 0) {
            reason += ` Not found: ${missing.join(', ')}.`;
          }
          return { ok: false as const, code: 'no_files', reason };
        }
        if (fit) {
          // W25-01: a ranked first look. The best-ranked files that fit the
          // caps are read, in rank order; the row records which ones.
          const chosen = fitRanked(picked, paths);
          return {
            ok: true as const,
            commitSha: head.sha,
            files: chosen.map((f) => ({ path: f.path, content: f.source })),
            skipped: { unsupported: all.unsupported, tooLarge: all.skipped, ...testsNote },
            leftOut: leftOutTests,
          };
        }
        const bytes = picked.reduce((n, f) => n + Buffer.byteLength(f.source), 0);
        if (picked.length > AI_PASS_MAX_FILES || bytes > AI_PASS_MAX_BYTES) {
          return {
            ok: false as const,
            code: 'too_large',
            reason: `That scope is ${picked.length} files and ${Math.round(bytes / 1024)} KB; a pass reads at most ${AI_PASS_MAX_FILES} files and ${Math.round(AI_PASS_MAX_BYTES / 1024)} KB. Name a smaller directory or specific files.`,
          };
        }
        return {
          ok: true as const,
          commitSha: head.sha,
          files: picked.map((f) => ({ path: f.path, content: f.source })),
          // Reported on the run, never silent (AI-85).
          skipped: { unsupported: all.unsupported, tooLarge: all.skipped, ...testsNote },
          leftOut: leftOutTests,
        };
      },
    );
  };
}
