import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read } from '@repopulse/shared';
import type { CodeIndex } from './code-index.js';
import {
  callersOf,
  definitionsOf,
  indexSnapshot,
  saveCodeIndex,
  storedCodeIndex,
} from './code-index-store.js';

// W22-01: one code map per repository, replaced per commit, workspace-filtered
// on every read (Law 5). Two workspaces with the same names, so a leak would
// return plausible rows rather than crash.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function mapOf(tag: string, extra: Partial<CodeIndex> = {}): CodeIndex {
  return {
    extractor: 'lodestone@test',
    files: [
      {
        path: `src/${tag}.ts`,
        contentHash: 'a'.repeat(64),
        language: 'typescript',
        method: 'tree-sitter',
        lineCount: 9,
      },
    ],
    defs: [{ path: `src/${tag}.ts`, symbol: 'helper', kind: 'function', startLine: 1, endLine: 3 }],
    refs: [{ path: `src/${tag}.ts`, symbol: 'helper', lines: [5, 7] }],
    calls: [{ path: `src/${tag}.ts`, caller: 'run', callee: 'helper', line: 5 }],
    imports: [{ path: `src/${tag}.ts`, target: './util', line: 1 }],
    truncated: false,
    buildMs: 12,
    ...extra,
  };
}

describeIfDb('code map store (W22-01)', () => {
  const db = createDb(databaseUrl as string);
  const ws: number[] = [];
  const repo: Record<number, number> = {};

  async function workspace(slug: string) {
    await db.insert(core.workspaces).values({ slug, name: slug }).onConflictDoNothing();
    return (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, slug))
    )[0]!.id;
  }

  beforeAll(async () => {
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w22-01@example.test',
        login: 'w22-01',
        email: 'w22-01@example.test',
      })
      .onConflictDoNothing();
    const userId = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w22-01@example.test'))
    )[0]!.id;
    for (const slug of ['w22-01-a', 'w22-01-b']) {
      const id = await workspace(slug);
      ws.push(id);
      await db.delete(read.codeIndexes).where(eq(read.codeIndexes.workspaceId, id));
      const [conn] = await db
        .insert(core.forgeConnections)
        .values({
          workspaceId: id,
          provider: 'github',
          authKind: 'pat',
          credentialCiphertext: Buffer.from('x'),
          credentialIv: Buffer.from('iv-1234567890123'),
          keyVersion: 1,
          credentialFingerprint: `w22-01-${id}-${Date.now()}`,
          status: 'active',
          createdBy: userId,
        })
        .returning({ id: core.forgeConnections.id });
      const [r] = await db
        .insert(core.repos)
        .values({
          workspaceId: id,
          connectionId: conn!.id,
          forgeRepoId: `w22-01-${id}-${Date.now()}`,
          org: 'w22-01',
          name: 'same-name',
          defaultBranch: 'main',
          isPrivate: false,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        })
        .returning({ id: core.repos.id });
      repo[id] = r!.id;
    }
  });

  afterAll(async () => {
    await db.delete(read.codeIndexes).where(inArray(read.codeIndexes.workspaceId, ws));
  });

  it('saves a map and reads it back only in its own workspace', async () => {
    const [a, b] = ws as [number, number];
    await saveCodeIndex(db, { workspaceId: a, repoId: repo[a]!, commitSha: 'c1' }, mapOf('a'));
    await saveCodeIndex(db, { workspaceId: b, repoId: repo[b]!, commitSha: 'c1' }, mapOf('b'));

    const callers = await callersOf(db, { workspaceId: a, repoId: repo[a]! }, 'helper');
    expect(callers).toEqual([{ path: 'src/a.ts', caller: 'run', callee: 'helper', line: 5 }]);
    const defs = await definitionsOf(db, { workspaceId: a, repoId: repo[a]! }, 'helper');
    expect(defs.map((d) => d.path)).toEqual(['src/a.ts']);

    // Workspace A asking about B's repository id gets nothing.
    expect(await callersOf(db, { workspaceId: a, repoId: repo[b]! }, 'helper')).toEqual([]);
    expect(await definitionsOf(db, { workspaceId: a, repoId: repo[b]! }, 'helper')).toEqual([]);
    expect(await storedCodeIndex(db, { workspaceId: a, repoId: repo[b]! })).toBeNull();
  });

  it('a newer commit replaces the map; no row of the old one is left', async () => {
    const [a, b] = ws as [number, number];
    const key = { workspaceId: a, repoId: repo[a]! };
    const before = await storedCodeIndex(db, key);
    expect(before?.commitSha).toBe('c1');
    await saveCodeIndex(db, { ...key, commitSha: 'c2' }, mapOf('a2'));
    expect((await storedCodeIndex(db, key))?.commitSha).toBe('c2');

    const rows = await db
      .select()
      .from(read.codeIndexes)
      .where(eq(read.codeIndexes.workspaceId, a));
    expect(rows).toHaveLength(1);
    for (const t of [
      read.codeIndexFiles,
      read.codeIndexDefs,
      read.codeIndexRefs,
      read.codeIndexCalls,
      read.codeIndexImports,
    ]) {
      const kids = await db.select().from(t).where(eq(t.workspaceId, a));
      expect(kids.every((k) => k.indexId === rows[0]!.id)).toBe(true);
      expect(kids.every((k) => k.path === 'src/a2.ts')).toBe(true);
    }
    // B's map is untouched.
    expect((await storedCodeIndex(db, { workspaceId: b, repoId: repo[b]! }))?.commitSha).toBe('c1');
  });

  it('indexSnapshot builds once per commit and extractor', async () => {
    const [a] = ws as [number];
    const key = { workspaceId: a, repoId: repo[a]!, commitSha: 'c3' };
    let builds = 0;
    const build = async () => {
      builds++;
      return mapOf('a3');
    };
    expect((await indexSnapshot(db, key, '/nowhere', build, 'lodestone@test')).status).toBe(
      'built',
    );
    expect((await indexSnapshot(db, key, '/nowhere', build, 'lodestone@test')).status).toBe(
      'up_to_date',
    );
    expect(builds).toBe(1);
    // A newer Lodestone rebuilds the same commit.
    expect((await indexSnapshot(db, key, '/nowhere', build, 'lodestone@next')).status).toBe(
      'built',
    );
    expect(builds).toBe(2);
  });

  it('every code-map table carries workspace_id NOT NULL and leads its indexes with it', async () => {
    const tables = [
      'code_indexes',
      'code_index_files',
      'code_index_defs',
      'code_index_refs',
      'code_index_calls',
      'code_index_imports',
    ];
    for (const t of tables) {
      const cols = (await db.execute(
        `select is_nullable from information_schema.columns where table_name = '${t}' and column_name = 'workspace_id'` as never,
      )) as unknown as { is_nullable: string }[];
      expect(cols, t).toEqual([{ is_nullable: 'NO' }]);
      const idx = (await db.execute(
        `select indexdef from pg_indexes where tablename = '${t}' and indexname not like '%_pkey'` as never,
      )) as unknown as { indexdef: string }[];
      expect(idx.length, t).toBeGreaterThan(0);
      for (const i of idx) expect(i.indexdef, t).toMatch(/\(workspace_id,/);
    }
  });
});
