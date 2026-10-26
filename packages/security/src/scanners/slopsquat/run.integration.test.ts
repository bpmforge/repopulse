import 'dotenv/config';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { scanOneTarget } from '../secrets/stream.js';
import { runSlopsquatDiffScan, runSlopsquatSnapshotScan } from './run.js';
import { SLOPSQUAT_SCANNER_KEY, SLOPSQUAT_VERSION } from './findings.js';

// The slopsquat scanner against a live database (W21-05): stored in shadow,
// one row per package across runs and modes, swept when the dependency goes,
// NOT swept when the index that proved it missing has gone, promoted by the
// registry, switched off per repo, riding the secrets stream, and confined to
// its own workspace.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const FP = 'w21-05-slopsquat-fp';
const SHA = 'w21-05-slopsquat-sha-0000000000000000';

function writeIndex(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'npm.tsv'), 'crossenv\nleft-pad\n');
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      generated: '2026-10-26T00:00:00Z',
      ecosystems: {
        npm: {
          file: 'npm.tsv',
          count: 2,
          source: 'test',
          generated: '2026-10-26T00:00:00Z',
          metadata: false,
        },
      },
    }),
  );
}

const manifest = (deps: Record<string, string>): string =>
  JSON.stringify({ name: 'app', dependencies: deps }, null, 2) + '\n';

describeIfDb('slopsquat scanner (W21-05)', () => {
  const db: Database = createDb(databaseUrl as string);
  const scratch = mkdtempSync(path.join(tmpdir(), 'w21-05-'));
  const tree = path.join(scratch, 'tree');
  const indexDir = path.join(scratch, 'index');
  const noIndex = path.join(scratch, 'no-index');
  let userId = 0;
  const ws: Record<'a' | 'b', { id: number; repoId: number }> = {
    a: { id: 0, repoId: 0 },
    b: { id: 0, repoId: 0 },
  };

  const rows = (w: 'a' | 'b') =>
    db
      .select()
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, ws[w].id),
          eq(read.findings.scannerKey, SLOPSQUAT_SCANNER_KEY),
        ),
      );

  const snapshot = (w: 'a' | 'b', index = indexDir) =>
    runSlopsquatSnapshotScan({
      db,
      workspaceId: ws[w].id,
      repoId: ws[w].repoId,
      commitSha: SHA,
      snapshotDir: tree,
      trigger: 'schedule',
      indexDir: index,
    });

  beforeAll(async () => {
    mkdirSync(tree, { recursive: true });
    writeIndex(indexDir);
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w21-05-user',
        forgeUserId: 'w21-05-user',
        login: 'w21-05-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w21-05-user' } })
      .returning();
    userId = user!.id;
    for (const w of ['a', 'b'] as const) {
      const [row] = await db
        .insert(core.workspaces)
        .values({ slug: `w21-05-${w}`, name: `W21-05 ${w}` })
        .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: `W21-05 ${w}` } })
        .returning();
      const [conn] = await db
        .insert(core.forgeConnections)
        .values({
          workspaceId: row!.id,
          provider: 'github',
          authKind: 'pat',
          credentialCiphertext: Buffer.from('x'),
          credentialIv: Buffer.from('iv-1234567890123'),
          keyVersion: 1,
          credentialFingerprint: `${FP}-${w}`,
          status: 'active',
          createdBy: userId,
        })
        .returning();
      const [repo] = await db
        .insert(core.repos)
        .values({
          workspaceId: row!.id,
          connectionId: conn!.id,
          forgeRepoId: `w21-05-repo-${w}`,
          org: 'acme',
          name: `slop-${w}`,
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        })
        .returning();
      ws[w] = { id: row!.id, repoId: repo!.id };
    }
  });

  afterAll(async () => {
    const ids = [ws.a.id, ws.b.id];
    await db.delete(read.findingEvents).where(inArray(read.findingEvents.workspaceId, ids));
    await db.delete(read.findings).where(inArray(read.findings.workspaceId, ids));
    await db.delete(security.scanRuns).where(inArray(security.scanRuns.workspaceId, ids));
    await db.delete(security.ruleRegistry).where(inArray(security.ruleRegistry.workspaceId, ids));
    await db
      .delete(security.repoScannerConfig)
      .where(inArray(security.repoScannerConfig.workspaceId, ids));
    await db.delete(core.repos).where(inArray(core.repos.workspaceId, ids));
    await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.workspaceId, ids));
    await db.delete(core.workspaces).where(inArray(core.workspaces.id, ids));
    await db.$client.end();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('stores both rules in shadow with the evidence, and states what it checked', async () => {
    writeFileSync(
      path.join(tree, 'package.json'),
      manifest({ react: '^18', 'react-codeshift': '^1', crossenv: '^6' }),
    );
    const result = await snapshot('a');
    expect(result).toMatchObject({ status: 'succeeded', signals: 2, findingsCreated: 2 });

    const found = await rows('a');
    const byRule = new Map(found.map((r) => [r.ruleId, r]));
    expect(byRule.get('slopsquat')).toMatchObject({
      dimension: 'dependency',
      file: 'package.json',
      lineStart: 5,
      experimental: true,
      status: 'open',
      severity: 4,
      tier: 1,
    });
    expect(byRule.get('slopsquat')!.evidence).toBe('package.json:5: "react-codeshift": "^1",');
    expect(byRule.get('slopsquat.near-miss')).toMatchObject({
      lineStart: 6,
      severity: 3,
      experimental: true,
    });

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.id, result.scanRunId!));
    expect(run).toMatchObject({
      status: 'succeeded',
      scannerKey: SLOPSQUAT_SCANNER_KEY,
      scannerVersion: SLOPSQUAT_VERSION,
      findingCount: 2,
    });
    expect(run!.toolVersions).toMatchObject({
      'registry.npm': '2 names, generated 2026-10-26T00:00:00Z',
    });
    expect(run!.toolVersions!['registry.pypi']).toMatch(/^not checked/);
  });

  it('keeps one row per package when the line moves, and closes it when the dependency goes', async () => {
    writeFileSync(
      path.join(tree, 'package.json'),
      manifest({ lodash: '^4', react: '^18', 'react-codeshift': '^1', crossenv: '^6' }),
    );
    expect(await snapshot('a')).toMatchObject({ findingsCreated: 0, signals: 2 });
    const moved = (await rows('a')).find((r) => r.ruleId === 'slopsquat')!;
    expect(moved.lineStart).toBe(6);
    expect((await rows('a')).filter((r) => r.status === 'open')).toHaveLength(2);

    writeFileSync(path.join(tree, 'package.json'), manifest({ react: '^18', crossenv: '^6' }));
    await snapshot('a');
    const after = await rows('a');
    expect(after.find((r) => r.ruleId === 'slopsquat')!.status).not.toBe('open');
    expect(after.find((r) => r.ruleId === 'slopsquat.near-miss')!.status).toBe('open');
  });

  it('does not close a missing-package finding just because the index is gone', async () => {
    writeFileSync(
      path.join(tree, 'package.json'),
      manifest({ react: '^18', 'react-codeshift': '^1' }),
    );
    await snapshot('a'); // reopened
    expect((await rows('a')).find((r) => r.ruleId === 'slopsquat')!.status).toBe('open');
    const blind = await snapshot('a', noIndex);
    expect(blind.notChecked['npm']).toMatch(/not checked: no package-name index/);
    expect((await rows('a')).find((r) => r.ruleId === 'slopsquat')!.status).toBe('open');
  });

  it('leaves shadow when the workspace promotes the rule', async () => {
    // The first run seeded a candidate row per rule that fired, so Settings ->
    // Rules lists them; an admin's promotion is a status change on that row.
    const seeded = await db
      .select()
      .from(security.ruleRegistry)
      .where(eq(security.ruleRegistry.workspaceId, ws.a.id));
    expect(seeded.map((r) => [r.ruleId, r.status]).sort()).toEqual([
      ['slopsquat', 'candidate'],
      ['slopsquat.near-miss', 'candidate'],
    ]);
    await db
      .update(security.ruleRegistry)
      .set({ status: 'active' })
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, ws.a.id),
          eq(security.ruleRegistry.ruleId, 'slopsquat'),
        ),
      );
    await snapshot('a');
    expect((await rows('a')).find((r) => r.ruleId === 'slopsquat')!.experimental).toBe(false);
  });

  it('diff mode: only added declarations, fetched at the head through the provider', async () => {
    const head = manifest({ react: '^18', 'react-codeshift': '^1', 'json-safe-parse-ultra': '^2' });
    const fetched: string[] = [];
    const provider = {
      getFileContent: async (_ctx: unknown, _repo: string, file: string) => {
        fetched.push(file);
        return { path: file, ref: SHA, sizeBytes: head.length, content: head, truncated: false };
      },
    } as unknown as ForgeProvider;
    const result = await runSlopsquatDiffScan({
      db,
      provider,
      repo: 'acme/slop-b',
      workspaceId: ws.b.id,
      repoId: ws.b.repoId,
      commitSha: SHA,
      trigger: 'pr_synced',
      files: [
        {
          path: 'package.json',
          status: 'modified',
          additions: 1,
          deletions: 0,
          patchTruncated: false,
          patch:
            '@@ -4,2 +4,3 @@\n     "react": "^18",\n     "react-codeshift": "^1",\n+    "json-safe-parse-ultra": "^2"\n',
        },
        {
          path: 'src/index.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          patchTruncated: false,
          patch: '@@ -1 +1 @@\n+x\n',
        },
      ],
      indexDir,
    });
    expect(fetched).toEqual(['package.json']);
    expect(result).toMatchObject({ status: 'succeeded', declarations: 1, signals: 1 });
    const [row] = await rows('b');
    expect(row).toMatchObject({
      ruleId: 'slopsquat',
      lineStart: 6,
      experimental: true,
      confidence: 5,
    });
    expect(row!.recommendation).toMatch(/json-safe-parse-ultra/);
  });

  it('is confined to its workspace: B never sees A, and A promoting a rule does not promote it for B', async () => {
    const before = (await rows('a')).length;
    writeFileSync(path.join(tree, 'package.json'), manifest({ 'react-codeshift': '^1' }));
    await snapshot('b');
    const b = (await rows('b')).find(
      (r) => r.file === 'package.json' && r.evidence.includes('react-codeshift'),
    )!;
    expect(b.experimental).toBe(true); // A's promotion is A's
    expect((await rows('a')).length).toBe(before);
    expect((await rows('a')).every((r) => r.workspaceId === ws.a.id)).toBe(true);
  });

  it('rides the secrets stream and honours a per-repo switch-off', async () => {
    const provider = {
      getCommitFiles: async () => ({
        items: [
          {
            path: 'requirements.txt',
            status: 'added',
            additions: 1,
            deletions: 0,
            patchTruncated: false,
            patch: '@@ -0,0 +1,1 @@\n+flask\n',
          },
        ],
      }),
    } as unknown as ForgeProvider;
    await scanOneTarget(
      { db, provider, repo: 'acme/slop-b', repoId: ws.b.repoId, workspaceId: ws.b.id },
      { commitSha: `${SHA}-push` },
      'push',
    );
    const runs = await db
      .select()
      .from(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.repoId, ws.b.repoId),
          eq(security.scanRuns.commitSha, `${SHA}-push`),
        ),
      );
    expect(runs.map((r) => r.scannerKey).sort()).toEqual([
      'secrets',
      'sensitive_change',
      'slopsquat',
    ]);
    expect(runs.find((r) => r.scannerKey === 'slopsquat')).toMatchObject({
      status: 'succeeded',
      trigger: 'push',
    });

    await db.insert(security.repoScannerConfig).values({
      workspaceId: ws.b.id,
      repoId: ws.b.repoId,
      scannerKey: SLOPSQUAT_SCANNER_KEY,
      enabled: false,
    });
    expect(await snapshot('b')).toMatchObject({ status: 'disabled', scanRunId: null });
  });
});
