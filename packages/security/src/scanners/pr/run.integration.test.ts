import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { core, createDb, facts, read, security, type Database } from '@repopulse/shared';
import { ForgeBudgetParkedError, type CallCtx, type ForgeProvider } from '@repopulse/forge';
import { registerBuiltinScanners } from '../../catalogue.js';
import { runAntiSlopScan } from '../anti-slop/run.js';
import type { SemgrepRunResult } from '../semgrep/scanner.js';
import {
  PR_PATTERN_SCANNERS,
  isDependencyManifest,
  pendingPrPatternTargets,
  runPrPatternScans,
  type PrScanRunners,
} from './run.js';

// W21-02: the pattern scanners on a PR push, end to end against a real
// database and a real tarball, with the container-backed engines replaced by
// recorders (this machine has no podman or opengrep). What is under test is the
// plan, the budget and the rows: one archive per head, scoping, the order the
// CI pull relies on, enablement, and that a head is not fetched twice.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const FP = 'w21-02-fp';

function tarballOf(files: Record<string, string>): Uint8Array {
  const stage = mkdtempSync(path.join(tmpdir(), 'w21-02-stage-'));
  const top = path.join(stage, 'acme-app-abc1234');
  mkdirSync(top, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(top, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const out = path.join(stage, 'archive.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', stage, path.basename(top)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return new Uint8Array(readFileSync(out));
}

interface Calls {
  tarballs: number;
  fileLists: number;
  contents: number;
  lanes: string[];
}

function fakeProvider(
  tree: Record<string, string>,
  changed: string[],
  calls: Calls,
  opts: { parkTarball?: boolean } = {},
): ForgeProvider {
  const bytes = tarballOf(tree);
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getTarball: async (ctx: CallCtx, _repo: string, sha: string) => {
      calls.lanes.push(ctx.lane);
      if (opts.parkTarball) throw new ForgeBudgetParkedError('scan', 'primary-floor', null);
      calls.tarballs += 1;
      return { commitSha: sha, bytes, sourceHost: 'codeload.github.com' };
    },
    getPullRequestFiles: async (ctx: CallCtx) => {
      calls.lanes.push(ctx.lane);
      calls.fileLists += 1;
      return {
        items: changed.map((p) => ({
          path: p,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: `@@ -0,0 +1 @@\n+${(tree[p] ?? '').split('\n')[0]}`,
          patchTruncated: false,
        })),
      };
    },
    getFileContent: async () => {
      calls.contents += 1;
      throw new Error('a PR scan must not fetch files one by one');
    },
  } as unknown as ForgeProvider;
}

const okPack = async (): Promise<SemgrepRunResult> => ({
  status: 'succeeded',
  findings: [],
  toolErrors: [],
  scannedPaths: [],
  erroredPaths: [],
  pathlessErrors: 0,
  durationMs: 1,
  toolVersions: { opengrep: 'test' },
});

describeIfLiveInfra('pattern scanners on a PR push (W21-02)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let identityId = 0;
  let prNumber = 9100;

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
        authSubject: 'w21-02-user',
        forgeUserId: 'w21-02-user',
        login: 'w21-02-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w21-02-user' } })
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
        forgeRepoId: 'w21-02-repo',
        org: 'acme',
        name: 'pr-patterns',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
    const [identity] = await db
      .insert(core.identities)
      .values({
        workspaceId,
        provider: 'github',
        forgeLogin: 'w21-02-author',
        displayName: 'W21-02',
      })
      .returning();
    identityId = identity!.id;
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db
      .delete(security.repoScannerConfig)
      .where(eq(security.repoScannerConfig.repoId, repoId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.repoId, repoId));
    await db.delete(core.identities).where(eq(core.identities.id, identityId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  beforeEach(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db
      .delete(security.repoScannerConfig)
      .where(eq(security.repoScannerConfig.repoId, repoId));
  });

  async function openPr(headSha: string, state = 'open') {
    prNumber += 1;
    const [pr] = await db
      .insert(facts.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: prNumber,
        forgePrId: `w21-02-pr-${prNumber}`,
        title: 'A change',
        authorIdentityId: identityId,
        state,
        isDraft: false,
        isBot: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        baseRef: 'main',
        headSha,
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      })
      .returning();
    return { commitSha: headSha, prNumber, pullRequestId: pr!.id };
  }

  /** Recording runners: what each scanner was handed, in the order called. */
  function recorders(sha = '') {
    const order: string[] = [];
    const seen: Record<string, unknown> = {};
    const row = async (key: string) => {
      await db.insert(security.scanRuns).values({
        workspaceId,
        repoId,
        scannerKey: key,
        scannerVersion: 'test',
        commitSha: sha,
        trigger: 'pr_synced',
        status: 'succeeded',
      });
    };
    const runners: Partial<PrScanRunners> = {
      semgrep: (async (d: Parameters<PrScanRunners['semgrep']>[0]) => {
        order.push('semgrep');
        seen['semgrepPaths'] = d.scoped?.paths;
        seen['semgrepDirFiles'] = d.scoped ? listFiles(d.scoped.dir) : null;
        seen['semgrepDir'] = d.scoped?.dir;
        await row('semgrep');
        return { status: 'succeeded', findingsCreated: 0 } as never;
      }) as never,
      antiSlop: (async (d: Parameters<PrScanRunners['antiSlop']>[0]) => {
        order.push('anti_slop');
        seen['antiSlopSources'] = d.sources?.length;
        seen['antiSlopTarget'] = d.targetDir;
        seen['antiSlopGateway'] = d.gateway;
        await row('anti_slop');
        return { status: 'succeeded', findingsCreated: 0 } as never;
      }) as never,
      logging: (async (d: Parameters<PrScanRunners['logging']>[0]) => {
        order.push('logging_hygiene');
        seen['loggingGateway'] = d.gateway;
        await row('logging_hygiene');
        return { status: 'succeeded', findingsCreated: 0 } as never;
      }) as never,
      perf: (async () => {
        order.push('performance');
        await row('performance');
        return { status: 'succeeded', findingsCreated: 0 } as never;
      }) as never,
      dependency: (async (d: Parameters<PrScanRunners['dependency']>[0]) => {
        order.push('dependency_cve');
        seen['dependencySnapshot'] = d.snapshot?.dir;
        seen['dependencyPr'] = d.pullRequestId;
        seen['dependencyTrigger'] = d.trigger;
        await row('dependency_cve');
        return { status: 'succeeded', findingsCreated: 0 } as never;
      }) as never,
      image: (async (d: Parameters<PrScanRunners['image']>[0]) => {
        order.push('container_image');
        seen['imageFiles'] = d.files ? (await d.files('')).map((f) => f.path) : null;
        await row('container_image');
        return { status: 'succeeded', findingsCreated: 0 } as never;
      }) as never,
    };
    return { order, seen, runners };
  }

  function listFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const next = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(next);
        else out.push(next);
      }
    };
    walk('');
    return out.sort();
  }

  const TREE = {
    'src/app.ts': 'export const a = 1;\n',
    'src/untouched.ts': 'export const b = 2;\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'README.md': 'hello\n',
  };

  it('fetches ONE archive for every scanner and scopes to the changed files', async () => {
    const target = await openPr('w21-02-sha-one');
    const calls: Calls = { tarballs: 0, fileLists: 0, contents: 0, lanes: [] };
    const rec = recorders(target.commitSha);
    const result = await runPrPatternScans({
      db,
      provider: fakeProvider(TREE, ['src/app.ts', 'README.md'], calls),
      workspaceId,
      repoId,
      repo: 'acme/pr-patterns',
      target,
      runners: rec.runners,
    });

    expect(calls).toMatchObject({ tarballs: 1, fileLists: 1, contents: 0 });
    expect(new Set(calls.lanes)).toEqual(new Set(['scan']));
    expect(result.forgeCalls).toEqual({ fileListPages: 1, tarballs: 1 });
    // No manifest changed: the dependency scan does not run; image is off by default.
    expect(rec.order).toEqual(['semgrep', 'anti_slop', 'logging_hygiene', 'performance']);
    expect(result.notApplicable).toEqual(['dependency_cve']);
    // Semgrep reads a directory holding only the changed files, and the
    // directory is gone afterwards.
    expect(rec.seen['semgrepPaths']).toEqual(['src/app.ts', 'README.md']);
    expect(rec.seen['semgrepDirFiles']).toEqual(['README.md', 'src/app.ts']);
    expect(existsSync(rec.seen['semgrepDir'] as string)).toBe(false);
    // Anti-slop reads the whole head's tree (two .ts sources) and no model.
    expect(rec.seen['antiSlopSources']).toBe(2);
    expect(rec.seen['antiSlopTarget']).toBe(rec.seen['semgrepDir']);
    expect(rec.seen['antiSlopGateway']).toBeUndefined();
    expect(rec.seen['loggingGateway']).toBeUndefined();
  });

  it('runs the dependency scan first, on the shared tree, when a lockfile changed', async () => {
    const target = await openPr('w21-02-sha-lock');
    const calls: Calls = { tarballs: 0, fileLists: 0, contents: 0, lanes: [] };
    const rec = recorders(target.commitSha);
    await runPrPatternScans({
      db,
      provider: fakeProvider(TREE, ['package-lock.json', 'src/app.ts'], calls),
      workspaceId,
      repoId,
      repo: 'acme/pr-patterns',
      target,
      runners: rec.runners,
    });
    expect(calls.tarballs).toBe(1);
    expect(rec.order[0]).toBe('dependency_cve');
    expect(rec.order).toContain('semgrep');
    expect(typeof rec.seen['dependencySnapshot']).toBe('string');
    expect(rec.seen['dependencyPr']).toBe(target.pullRequestId);
    expect(rec.seen['dependencyTrigger']).toBe('pr_synced');
  });

  it('does not fetch a head twice', async () => {
    const target = await openPr('w21-02-sha-twice');
    const calls: Calls = { tarballs: 0, fileLists: 0, contents: 0, lanes: [] };
    const provider = fakeProvider(TREE, ['src/app.ts'], calls);
    const deps = { db, provider, workspaceId, repoId, repo: 'acme/pr-patterns', target };
    await runPrPatternScans({ ...deps, runners: recorders(target.commitSha).runners });
    const again = await runPrPatternScans({
      ...deps,
      runners: recorders(target.commitSha).runners,
    });
    expect(again.skipped).toBe('already_scanned');
    expect(calls).toMatchObject({ tarballs: 1, fileLists: 1 });
    const pending = await pendingPrPatternTargets(db, workspaceId, repoId, 10);
    expect(pending.map((p) => p.commitSha)).not.toContain('w21-02-sha-twice');
  });

  it('respects per-repo enablement, and image scanning only once it is turned on', async () => {
    await db.insert(security.repoScannerConfig).values([
      { workspaceId, repoId, scannerKey: 'semgrep', enabled: false },
      { workspaceId, repoId, scannerKey: 'container_image', enabled: true },
    ]);
    const tree = {
      ...TREE,
      Dockerfile: 'FROM node:20.11-alpine\n',
      '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
    };
    const target = await openPr('w21-02-sha-image');
    const calls: Calls = { tarballs: 0, fileLists: 0, contents: 0, lanes: [] };
    const rec = recorders(target.commitSha);
    await runPrPatternScans({
      db,
      provider: fakeProvider(tree, ['Dockerfile', '.github/workflows/ci.yml'], calls),
      workspaceId,
      repoId,
      repo: 'acme/pr-patterns',
      target,
      runners: rec.runners,
    });
    expect(rec.order).not.toContain('semgrep');
    expect(rec.order[0]).toBe('container_image');
    // Only the changed file that names an image is handed to the image scan.
    expect(rec.seen['imageFiles']).toEqual(['Dockerfile']);

    // A changed YAML that names no image does not start it.
    const target2 = await openPr('w21-02-sha-yaml');
    const rec2 = recorders(target2.commitSha);
    const r2 = await runPrPatternScans({
      db,
      provider: fakeProvider(tree, ['.github/workflows/ci.yml'], calls),
      workspaceId,
      repoId,
      repo: 'acme/pr-patterns',
      target: target2,
      runners: rec2.runners,
    });
    expect(rec2.order).not.toContain('container_image');
    expect(r2.notApplicable).toContain('container_image');
  });

  it('skips with no forge call when every pattern scanner is off', async () => {
    await db.insert(security.repoScannerConfig).values(
      PR_PATTERN_SCANNERS.map((scannerKey) => ({
        workspaceId,
        repoId,
        scannerKey,
        enabled: false,
      })),
    );
    const target = await openPr('w21-02-sha-off');
    const calls: Calls = { tarballs: 0, fileLists: 0, contents: 0, lanes: [] };
    const r = await runPrPatternScans({
      db,
      provider: fakeProvider(TREE, ['src/app.ts'], calls),
      workspaceId,
      repoId,
      repo: 'acme/pr-patterns',
      target,
      runners: recorders(target.commitSha).runners,
    });
    expect(r.skipped).toBe('disabled');
    expect(calls).toMatchObject({ tarballs: 0, fileLists: 0 });
  });

  it('records budget_exceeded for each scanner when the budget is spent, and retries that head', async () => {
    const target = await openPr('w21-02-sha-parked');
    const calls: Calls = { tarballs: 0, fileLists: 0, contents: 0, lanes: [] };
    const rec = recorders(target.commitSha);
    await runPrPatternScans({
      db,
      provider: fakeProvider(TREE, ['src/app.ts'], calls, { parkTarball: true }),
      workspaceId,
      repoId,
      repo: 'acme/pr-patterns',
      target,
      runners: rec.runners,
    });
    expect(rec.order).toEqual([]);
    const rows = await db
      .select({ key: security.scanRuns.scannerKey, status: security.scanRuns.status })
      .from(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.repoId, repoId),
          eq(security.scanRuns.commitSha, 'w21-02-sha-parked'),
        ),
      );
    expect(rows.map((r) => r.key).sort()).toEqual(
      ['anti_slop', 'logging_hygiene', 'performance', 'semgrep'].sort(),
    );
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['budget_exceeded']));
    const pending = await pendingPrPatternTargets(db, workspaceId, repoId, 10);
    expect(pending.map((p) => p.commitSha)).toContain('w21-02-sha-parked');
  });

  it('leaves closed PRs alone', async () => {
    await openPr('w21-02-sha-closed', 'closed');
    const pending = await pendingPrPatternTargets(db, workspaceId, repoId, 50);
    expect(pending.map((p) => p.commitSha)).not.toContain('w21-02-sha-closed');
  });

  it('anti-slop on a PR reports only on the files the PR changed', async () => {
    const tree = {
      'src/changed.ts': "import { gone } from './nowhere';\nexport const x = gone;\n",
      'src/old.ts': "import { lost } from './nowhere-else';\nexport const y = lost;\n",
    };
    const target = await openPr('w21-02-sha-slop');
    const calls: Calls = { tarballs: 0, fileLists: 0, contents: 0, lanes: [] };
    const rec = recorders(target.commitSha);
    await runPrPatternScans({
      db,
      provider: fakeProvider(tree, ['src/changed.ts'], calls),
      workspaceId,
      repoId,
      repo: 'acme/pr-patterns',
      target,
      runners: {
        ...rec.runners,
        antiSlop: (d) => runAntiSlopScan({ ...d, runPack: okPack }),
      },
    });
    const found = await db
      .select({ file: read.findings.file, pr: read.findings.pullRequestId })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.scannerKey, 'anti_slop')));
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found.map((f) => f.file))).toEqual(new Set(['src/changed.ts']));
    expect(new Set(found.map((f) => f.pr))).toEqual(new Set([target.pullRequestId]));
    const [run] = await db
      .select({ status: security.scanRuns.status, trigger: security.scanRuns.trigger })
      .from(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.repoId, repoId),
          eq(security.scanRuns.scannerKey, 'anti_slop'),
          eq(security.scanRuns.commitSha, 'w21-02-sha-slop'),
        ),
      );
    expect(run).toEqual({ status: 'succeeded', trigger: 'pr_synced' });
  });
});

describe('isDependencyManifest (W21-02)', () => {
  it('knows lockfiles and manifests, in any directory', () => {
    for (const f of [
      'package-lock.json',
      'web/pnpm-lock.yaml',
      'requirements-dev.txt',
      'go.sum',
      'svc/Cargo.toml',
      'app/App.csproj',
      'Gemfile.lock',
    ]) {
      expect(isDependencyManifest(f), f).toBe(true);
    }
    for (const f of ['src/index.ts', 'README.md', 'Dockerfile', 'package.jsonc']) {
      expect(isDependencyManifest(f), f).toBe(false);
    }
  });
});
