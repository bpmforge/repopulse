import { and, asc, eq } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import type { CodeIndex } from './code-index.js';

// Persistence for the code map (W22-01). One map per repository: saving a newer
// commit deletes the old map (its rows cascade) and writes the new one in one
// transaction, so a reader sees the old map or the new one, never half of each.
// Every statement is workspace-filtered (Law 5).

const CHUNK = 2_000;

export interface CodeIndexKey {
  workspaceId: number;
  repoId: number;
}

/** The commit and extractor the stored map was built with, or null when there is none. */
export async function storedCodeIndex(
  db: Database,
  key: CodeIndexKey,
): Promise<{ commitSha: string; extractor: string } | null> {
  const [row] = await db
    .select({ commitSha: read.codeIndexes.commitSha, extractor: read.codeIndexes.extractor })
    .from(read.codeIndexes)
    .where(
      and(
        eq(read.codeIndexes.workspaceId, key.workspaceId),
        eq(read.codeIndexes.repoId, key.repoId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function insertChunks<T extends object>(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  table: Parameters<Database['insert']>[0],
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(table).values(rows.slice(i, i + CHUNK) as never);
  }
}

/** Replaces the repository's map with `index`, built at `commitSha`. Returns the new id. */
export async function saveCodeIndex(
  db: Database,
  key: CodeIndexKey & { commitSha: string },
  index: CodeIndex,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .delete(read.codeIndexes)
      .where(
        and(
          eq(read.codeIndexes.workspaceId, key.workspaceId),
          eq(read.codeIndexes.repoId, key.repoId),
        ),
      );
    const [row] = await tx
      .insert(read.codeIndexes)
      .values({
        workspaceId: key.workspaceId,
        repoId: key.repoId,
        commitSha: key.commitSha,
        extractor: index.extractor,
        fileCount: index.files.length,
        defCount: index.defs.length,
        refCount: index.refs.length,
        callCount: index.calls.length,
        importCount: index.imports.length,
        truncated: index.truncated,
        buildMs: index.buildMs,
      })
      .returning({ id: read.codeIndexes.id });
    const base = { workspaceId: key.workspaceId, indexId: row!.id };
    await insertChunks(
      tx,
      read.codeIndexFiles,
      index.files.map((f) => ({ ...base, ...f })),
    );
    await insertChunks(
      tx,
      read.codeIndexDefs,
      index.defs.map((d) => ({ ...base, ...d })),
    );
    await insertChunks(
      tx,
      read.codeIndexRefs,
      index.refs.map((r) => ({ ...base, ...r })),
    );
    await insertChunks(
      tx,
      read.codeIndexCalls,
      index.calls.map((c) => ({ ...base, ...c })),
    );
    await insertChunks(
      tx,
      read.codeIndexImports,
      index.imports.map((i) => ({ ...base, ...i })),
    );
    return row!.id;
  });
}

export interface StoredCall {
  path: string;
  caller: string;
  callee: string;
  line: number;
}

/** Call sites of `symbol` in the repository's current map, path then line order. */
export async function callersOf(
  db: Database,
  key: CodeIndexKey,
  symbol: string,
  limit = 50,
): Promise<StoredCall[]> {
  return db
    .select({
      path: read.codeIndexCalls.path,
      caller: read.codeIndexCalls.caller,
      callee: read.codeIndexCalls.callee,
      line: read.codeIndexCalls.line,
    })
    .from(read.codeIndexCalls)
    .innerJoin(
      read.codeIndexes,
      and(
        eq(read.codeIndexes.id, read.codeIndexCalls.indexId),
        eq(read.codeIndexes.workspaceId, read.codeIndexCalls.workspaceId),
      ),
    )
    .where(
      and(
        eq(read.codeIndexCalls.workspaceId, key.workspaceId),
        eq(read.codeIndexes.repoId, key.repoId),
        eq(read.codeIndexCalls.callee, symbol),
      ),
    )
    .orderBy(asc(read.codeIndexCalls.path), asc(read.codeIndexCalls.line))
    .limit(limit);
}

/** Where `symbol` is defined in the repository's current map. */
export async function definitionsOf(
  db: Database,
  key: CodeIndexKey,
  symbol: string,
  limit = 20,
): Promise<{ path: string; kind: string; startLine: number; endLine: number }[]> {
  return db
    .select({
      path: read.codeIndexDefs.path,
      kind: read.codeIndexDefs.kind,
      startLine: read.codeIndexDefs.startLine,
      endLine: read.codeIndexDefs.endLine,
    })
    .from(read.codeIndexDefs)
    .innerJoin(
      read.codeIndexes,
      and(
        eq(read.codeIndexes.id, read.codeIndexDefs.indexId),
        eq(read.codeIndexes.workspaceId, read.codeIndexDefs.workspaceId),
      ),
    )
    .where(
      and(
        eq(read.codeIndexDefs.workspaceId, key.workspaceId),
        eq(read.codeIndexes.repoId, key.repoId),
        eq(read.codeIndexDefs.symbol, symbol),
      ),
    )
    .orderBy(asc(read.codeIndexDefs.path), asc(read.codeIndexDefs.startLine))
    .limit(limit);
}

/**
 * Builds and saves the map for the snapshot at `dir` unless the stored map is
 * already of this commit, by this extractor. The hook the scan batch calls while the tree exists.
 */
export async function indexSnapshot(
  db: Database,
  key: CodeIndexKey & { commitSha: string },
  dir: string,
  build: (dir: string) => Promise<CodeIndex>,
  extractor: string,
): Promise<{ status: 'built'; index: CodeIndex } | { status: 'up_to_date' }> {
  // Same commit by the same Lodestone: nothing to do. A newer Lodestone
  // rebuilds the map of the same commit, since it may read more.
  const stored = await storedCodeIndex(db, key);
  if (stored?.commitSha === key.commitSha && stored.extractor === extractor)
    return { status: 'up_to_date' };
  const index = await build(dir);
  await saveCodeIndex(db, key, index);
  return { status: 'built', index };
}
