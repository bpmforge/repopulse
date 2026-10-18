import { and, desc, eq } from 'drizzle-orm';
import { core, facts, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { readSnapshotSources, snapshotForScan } from '@repopulse/security';
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

export interface SnapshotSourceDeps {
  db: Database;
  forgeFor: (
    workspaceId: number,
    repoId: number,
  ) => Promise<{ provider: ForgeProvider; repoFullName: string } | null>;
}

export function snapshotSources(deps: SnapshotSourceDeps): AiPassDeps['loadSources'] {
  return async ({ workspaceId, repoId, paths }) => {
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
        const all = readSnapshotSources(snapshot.dir, { maxFiles: 5000 });
        const picked = all.files.filter((f) => inScope(f.path, paths));
        if (picked.length === 0) {
          return {
            ok: false as const,
            code: 'no_files',
            reason: `None of the paths (${paths.join(', ')}) matched a readable source file at ${head.sha.slice(0, 8)}.`,
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
        };
      },
    );
  };
}
