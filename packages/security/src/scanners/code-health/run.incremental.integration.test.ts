import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { registerBuiltinScanners } from '../../catalogue.js';
import { runCodeHealthScan, type CodeHealthRunDeps } from './run.js';
import type { ToolRunResult } from './tools.js';

// Incremental code_health_tools against the REAL store (W23-03).
//
// Base: a full run over A, B, C, D, each with one finding. Then B changes and D
// is deleted. The incremental run must fetch only B, replace B's finding, leave
// A and C open and re-sighted on the new run (same rows, new last_seen), and
// close D's. The tools (a container) are a stand-in that reads the files it is
// handed, so what is real here is the planner, the sweep, the carry-forward and
// the run rows. Needs DATABASE_URL; self-skips without it, like its siblings.

const databaseUrl = process.env.DATABASE_URL;
const describeIfReady = databaseUrl ? describe : describe.skip;
const FP = 'w23-03-fp';

const stubTools = (async (a: { targetDir: string }): Promise<ToolRunResult> => {
  const walk = (dir: string, rel = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`],
    );
  const findings = walk(a.targetDir).map((file) => {
    const v2 = readFileSync(path.join(a.targetDir, file), 'utf8').includes('v2');
    return {
      ruleId: v2 ? 'complexity.function_length' : 'complexity.cyclomatic',
      file,
      lineStart: 1,
      lineEnd: 9,
      severity: 2,
      title: `${v2 ? 'function_length' : 'cyclomatic'}: ${file}`,
      message: 'too much',
      measured: 30,
      threshold: 10,
    };
  });
  return {
    status: 'succeeded',
    findings,
    adapterFindings: [],
    adapterErrors: [],
    metrics: { ch_duplication_pct: 1, ch_complexity_p90: 4, ch_worst_fn_count: 0 },
    toolVersions: { lizard: '1.24.0', jscpd: '4.3.0' },
  };
}) as never;

function tarball(): Uint8Array {
  const stage = mkdtempSync(path.join(tmpdir(), 'w23-03-stage-'));
  const top = path.join(stage, 'acme-inc-abc1234');
  mkdirSync(path.join(top, 'src'), { recursive: true });
  for (const f of ['a', 'b', 'c', 'd'])
    writeFileSync(path.join(top, `src/${f}.ts`), `// ${f} v1\n`);
  const out = path.join(stage, 'archive.tar.gz');
  // COPYFILE_DISABLE: no macOS AppleDouble `._name` sidecars, which a forge
  // archive never holds (same as snapshot.test.ts).
  execFileSync('tar', ['-czf', out, '-C', stage, path.basename(top)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return new Uint8Array(readFileSync(out));
}

describeIfReady('incremental code_health_tools (W23-03)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  const fetched: string[] = [];

  const provider = (): ForgeProvider => {
    const bytes = tarball();
    return {
      kind: 'github',
      capabilities: { supportsTarball: true },
      getTarball: async (_c: unknown, _r: string, sha: string) => ({
        commitSha: sha,
        bytes,
        sourceHost: 'codeload.github.com',
      }),
      getFileContent: async (_c: unknown, _r: string, file: string) => {
        fetched.push(file);
        return { path: file, content: '// b v2\n' };
      },
      compareCommits: async () => ({
        truncated: false,
        files: [
          { path: 'src/b.ts', status: 'modified' },
          { path: 'src/d.ts', status: 'removed' },
        ],
      }),
    } as unknown as ForgeProvider;
  };

  const deps = (over: Partial<CodeHealthRunDeps>): CodeHealthRunDeps => ({
    db,
    provider: provider(),
    workspaceId,
    repoId,
    repo: 'acme/inc',
    commitSha: 'w23-03-base',
    trigger: 'manual',
    runTools: stubTools,
    ...over,
  });

  const findingsOf = async () =>
    db
      .select()
      .from(read.findings)
      .where(
        and(eq(read.findings.repoId, repoId), eq(read.findings.scannerKey, 'code_health_tools')),
      );

  beforeAll(async () => {
    registerBuiltinScanners();
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w23-03-user',
        forgeUserId: 'w23-03-user',
        login: 'w23-03-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w23-03-user' } })
      .returning();
    userId = user!.id;
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: FP,
        status: 'active',
        createdBy: userId,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w23-03-repo',
        org: 'acme',
        name: 'inc',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
  });

  afterAll(async () => {
    const ids = db
      .select({ id: read.findings.id })
      .from(read.findings)
      .where(eq(read.findings.repoId, repoId));
    await db.delete(read.findingEvents).where(inArray(read.findingEvents.findingId, ids));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it("base full run, then B changed and D deleted: the merge keeps the whole tree's answer", async () => {
    const base = await runCodeHealthScan(deps({ force: true }));
    expect(base.status).toBe('succeeded');
    expect(base.scope).toBeUndefined();
    const before = await findingsOf();
    expect(before.map((f) => f.file).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
    ]);
    fetched.length = 0;

    const inc = await runCodeHealthScan(deps({ commitSha: 'w23-03-head' }));
    expect(inc).toMatchObject({ status: 'succeeded', scope: 'incremental', filesScanned: 1 });
    // one contents call, for B only: no tarball for this run
    expect(fetched).toEqual(['src/b.ts']);

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.id, inc.scanRunId as number));
    expect(run).toMatchObject({
      scope: 'incremental',
      baseRunId: base.scanRunId,
      status: 'succeeded',
    });

    const after = await findingsOf();
    const of = (file: string, rule: string) =>
      after.find((f) => f.file === file && f.ruleId === rule);

    // A and C: the SAME rows, still open, re-sighted on the new run
    for (const file of ['src/a.ts', 'src/c.ts']) {
      const was = before.find((f) => f.file === file)!;
      const now = of(file, 'complexity.cyclomatic')!;
      expect(now.id).toBe(was.id);
      expect(now.status).toBe('open');
      expect(now.lastSeenScanRunId).toBe(inc.scanRunId);
      expect(now.occurrenceCount).toBe(was.occurrenceCount + 1);
      expect(now.lastSeenAt.getTime()).toBeGreaterThanOrEqual(was.lastSeenAt.getTime());
    }
    // B: the old finding is replaced by what the new scan reports
    expect(of('src/b.ts', 'complexity.cyclomatic')!.status).toBe('resolved');
    expect(of('src/b.ts', 'complexity.function_length')).toMatchObject({
      status: 'open',
      lastSeenScanRunId: inc.scanRunId,
    });
    // D: deleted, so closed, with an event naming the run
    const d = of('src/d.ts', 'complexity.cyclomatic')!;
    expect(d.status).toBe('resolved');
    const events = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.findingId, d.id));
    expect(events.at(-1)).toMatchObject({
      toStatus: 'resolved',
      reason: 'outdated_diff',
      scanRunId: inc.scanRunId,
    });
  });
});
