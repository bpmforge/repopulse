import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { execFileSync as exec } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { runSemgrepFull, runSemgrepIncremental } from './run-modes.js';
import { triageOutcome } from './triage.js';

// Full and incremental semgrep modes, end to end (W8-07, FR-SEC-6).
//
// The engine really runs, in the sandbox, over a real tarball this test builds
// — because the two things most likely to be wrong are the ones a unit test
// cannot see: whether the rulepack reaches a container with no network, and
// whether findings survive the trip into the store with their rule ids intact.

const databaseUrl = process.env.DATABASE_URL;

const scanImage = (() => {
  try {
    return execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
})();

const describeIfReady = databaseUrl && scanImage ? describe : describe.skip;

const VULNERABLE = [
  'const cp = require("node:child_process");',
  'function handler(req, db) {',
  '  eval(req.body.q);',
  '  db.query(`select * from t where id = ${req.params.id}`);',
  '  return cp.exec("ls " + req.query.dir);',
  '}',
  'module.exports = { handler };',
].join('\n');

const FP = 'w8-07-fp';
const SHA = 'w8-07-commit-sha-000000000000000000000';

/** A real gzipped tar, built by the system tar — same discipline as W8-03. */
function tarballOf(files: Record<string, string>): Uint8Array {
  const stage = mkdtempSync(path.join(tmpdir(), 'w8-07-stage-'));
  const top = path.join(stage, 'acme-app-abc1234');
  mkdirSync(top, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(top, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const out = path.join(stage, 'archive.tar.gz');
  exec('tar', ['-czf', out, '-C', stage, path.basename(top)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return new Uint8Array(readFileSync(out));
}

function fakeProvider(files: Record<string, string>, calls: CallCtx[]): ForgeProvider {
  const bytes = tarballOf(files);
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getTarball: async (ctx: CallCtx, _repo: string, sha: string) => {
      calls.push(ctx);
      return { commitSha: sha, bytes, sourceHost: 'codeload.github.com' };
    },
    getPullRequestFiles: async (ctx: CallCtx) => {
      calls.push(ctx);
      return {
        items: Object.keys(files).map((p) => ({ path: p, patch: null, status: 'modified' })),
      };
    },
    getFileContent: async (ctx: CallCtx, _repo: string, filePath: string, ref: string) => {
      calls.push(ctx);
      return {
        path: filePath,
        ref,
        sizeBytes: files[filePath]?.length ?? 0,
        content: files[filePath] ?? null,
        truncated: false,
      };
    },
  } as unknown as ForgeProvider;
}

describeIfReady('semgrep full + incremental (W8-07)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w8-07-user', forgeUserId: 'w8-07-user', login: 'w8-07-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-07-user' } })
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
        forgeRepoId: 'w8-07-repo',
        org: 'acme',
        name: 'sast',
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
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('FULL mode scans a snapshot and stores findings with their rule ids', async () => {
    const calls: CallCtx[] = [];
    const result = await runSemgrepFull({
      db,
      provider: fakeProvider({ 'src/handler.js': VULNERABLE, 'README.md': '# app' }, calls),
      workspaceId,
      repoId,
      repo: 'acme/sast',
      commitSha: SHA,
      image: scanImage as string,
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.findingsCreated).toBeGreaterThanOrEqual(3);
    // The archive was fetched on the scan lane, not a user's.
    expect(calls.map((c) => c.lane)).toContain('scan');

    const rows = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'sast')));
    const ruleIds = [...new Set(rows.map((r) => r.ruleId))].sort();
    expect(ruleIds).toContain('bpm-js-eval-dynamic');
    expect(ruleIds).toContain('bpm-js-sql-string-concat');
    // The mount point never reaches a stored path.
    for (const row of rows) expect(row.file?.startsWith('/scan')).toBe(false);
    expect(rows.every((r) => r.scannerKey === 'semgrep')).toBe(true);
    // Yields are carried for the chainer (W8-09).
    expect(rows.some((r) => (r.yields as Record<string, unknown> | null)?.['rce'] === true)).toBe(
      true,
    );

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.repoId, repoId));
    expect(run?.status).toBe('succeeded');
    // BOTH versions: "which of the two changed" is the first question when a
    // finding appears or disappears between runs.
    expect(run?.toolVersions?.['opengrep']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(run?.toolVersions?.['rulepack']).toContain('bpm-baseline.v1.yaml');
  }, 600_000);

  it('re-running FULL over unchanged code creates ZERO new rows', async () => {
    const before = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    const result = await runSemgrepFull({
      db,
      provider: fakeProvider({ 'src/handler.js': VULNERABLE }, []),
      workspaceId,
      repoId,
      repo: 'acme/sast',
      commitSha: SHA,
      image: scanImage as string,
    });
    expect(result.status).toBe('succeeded');
    expect(result.findingsCreated).toBe(0);
    const after = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(after.length).toBe(before.length);
  }, 600_000);

  it('INCREMENTAL mode catches a regression in a PR, fetching files not a tarball', async () => {
    const calls: CallCtx[] = [];
    const provider = fakeProvider(
      { 'src/new-endpoint.js': 'module.exports = (req) => eval(req.body.code);\n' },
      calls,
    );
    const result = await runSemgrepIncremental({
      db,
      provider,
      workspaceId,
      repoId,
      repo: 'acme/sast',
      commitSha: 'w8-07-pr-head-sha-0000000000000000',
      prNumber: 42,
      image: scanImage as string,
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.filesScanned).toBe(1);
    expect(result.findingsTotal).toBeGreaterThanOrEqual(1);

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(and(eq(security.scanRuns.repoId, repoId), eq(security.scanRuns.trigger, 'pr_synced')));
    expect(run?.status).toBe('succeeded');

    const rows = await db
      .select()
      .from(read.findings)
      .where(
        and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'bpm-js-eval-dynamic')),
      );
    expect(rows.some((r) => r.file === 'src/new-endpoint.js')).toBe(true);
  }, 600_000);

  it('an incremental run with no scannable files still records that it looked', async () => {
    const result = await runSemgrepIncremental({
      db,
      provider: fakeProvider({ 'docs/README.md': '# nothing to scan' }, []),
      workspaceId,
      repoId,
      repo: 'acme/sast',
      commitSha: 'w8-07-docs-only-sha-000000000000',
      prNumber: 43,
      image: scanImage as string,
    });
    // Skipped is the RESULT, but a run row exists: "we looked and there was
    // nothing to look at" is a fact the next run needs.
    expect(result.status).toBe('skipped');
    expect(result.scanRunId).not.toBeNull();
    expect(result.filesScanned).toBe(0);
  }, 300_000);
});

describe('triage mapping (§1.3)', () => {
  it('maps REAL, FP and UNVERIFIED onto the lifecycle', () => {
    expect(triageOutcome('REAL').status).toBe('confirmed');
    expect(triageOutcome('FP')).toMatchObject({
      status: 'dismissed',
      dismissReason: 'false_positive',
    });
    // UNVERIFIED is an UNJUDGED finding, not a weaker one — a queue that hides
    // what nobody has looked at reports itself finished.
    expect(triageOutcome('UNVERIFIED').status).toBe('open');
    expect(triageOutcome('UNVERIFIED').dismissReason).toBeNull();
  });

  it('uses false_positive specifically, because that is the tuning signal', () => {
    // 'not applicable' and 'accepted risk' are decisions about this codebase;
    // only false_positive says the RULE was wrong.
    expect(triageOutcome('FP').dismissReason).toBe('false_positive');
  });

  it('every verdict carries a reason for the audit trail', () => {
    for (const verdict of ['REAL', 'FP', 'UNVERIFIED'] as const) {
      expect(triageOutcome(verdict).reason.length).toBeGreaterThan(10);
    }
  });
});
