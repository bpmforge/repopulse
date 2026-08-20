import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { runCodeHealthScan } from './run.js';

// code_health_tools end to end (W9-02, FR-CH-2).
//
// A snapshot is taken, both tools run in the sandbox, findings land in the
// store and the posture numbers land in metric_snapshots — where the EXISTING
// trend endpoint reads them, which is the whole reason they go there rather
// than into a table of their own.

const databaseUrl = process.env.DATABASE_URL;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/code-health-tools');

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

const FP = 'w9-02-fp';
const SHA = 'w9-02-commit-sha-00000000000000000000';

/** A real archive of the boundary fixtures, built by the system tar. */
function tarball(): Uint8Array {
  const stage = mkdtempSync(path.join(tmpdir(), 'w9-02-stage-'));
  const top = path.join(stage, 'acme-app-abc1234');
  mkdirSync(top, { recursive: true });
  writeFileSync(path.join(top, 'boundary.js'), readFileSync(path.join(FIXTURES, 'boundary.js')));
  // A second copy, so the duplication half has something to find.
  writeFileSync(path.join(top, 'copy.js'), readFileSync(path.join(FIXTURES, 'boundary.js')));
  const out = path.join(stage, 'archive.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', stage, path.basename(top)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return new Uint8Array(readFileSync(out));
}

function fakeProvider(calls: CallCtx[]): ForgeProvider {
  const bytes = tarball();
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getTarball: async (ctx: CallCtx, _repo: string, sha: string) => {
      calls.push(ctx);
      return { commitSha: sha, bytes, sourceHost: 'codeload.github.com' };
    },
  } as unknown as ForgeProvider;
}

describeIfReady('code_health_tools scan (W9-02)', () => {
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
      .values({ authProvider: 'github', authSubject: 'w9-02-user', forgeUserId: 'w9-02-user', login: 'w9-02-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w9-02-user' } })
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
        forgeRepoId: 'w9-02-repo',
        org: 'acme',
        name: 'health',
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
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('scans a snapshot, stores findings and writes the ch_* posture metrics', async () => {
    const calls: CallCtx[] = [];
    const result = await runCodeHealthScan({
      db,
      provider: fakeProvider(calls),
      workspaceId,
      repoId,
      repo: 'acme/health',
      commitSha: SHA,
      image: scanImage as string,
      trigger: 'manual',
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.findingsCreated).toBeGreaterThan(0);
    // The archive came down the scan lane, like every other scanner fetch.
    expect(calls.map((c) => c.lane)).toEqual(['scan']);

    const findings = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'code_health')));
    const rules = new Set(findings.map((f) => f.ruleId));
    expect([...rules].some((r) => r?.startsWith('complexity.'))).toBe(true);
    expect([...rules].some((r) => r?.startsWith('duplication.'))).toBe(true);
    // Measurements, not opinions: OUR findings are confidence 5, and the
    // evidence carries the number and the threshold so a reader can argue with
    // the threshold rather than with the tool.
    //
    // Tool-adapter findings (ruff, Biome) live in the same dimension but are
    // confidence 4 and namespaced `tool.<key>.<rule>` — a lint rule is a
    // heuristic about a pattern where a cyclomatic complexity of 23 is a
    // count, and the stored confidence should say which one a reader is
    // looking at.
    const ours = findings.filter((f) => !f.ruleId?.startsWith('tool.'));
    const fromTools = findings.filter((f) => f.ruleId?.startsWith('tool.'));
    expect(ours.every((f) => f.confidence === 5)).toBe(true);
    expect(fromTools.every((f) => f.confidence === 4)).toBe(true);
    // The adapters RAN and were counted, whether or not this particular
    // fixture trips one of their rules — an `every()` over an empty list is
    // vacuously true, and that is exactly how a wiring regression would hide.
    expect(result.adapterErrors).toEqual([]);
    expect(result.adapterFindings).toBeGreaterThanOrEqual(0);
    expect(ours[0]?.evidence).toMatch(/measured \d+, threshold \d+/);
    // Nothing here feeds the chainer: complexity hands an attacker nothing.
    expect(findings.every((f) => f.yields === null)).toBe(true);

    const metrics = await db
      .select()
      .from(read.metricSnapshots)
      .where(eq(read.metricSnapshots.repoId, repoId))
      .orderBy(desc(read.metricSnapshots.computedAt));
    const keys = new Set(metrics.map((m) => m.metricKey));
    expect(keys).toContain('ch_duplication_pct');
    expect(keys).toContain('ch_complexity_p90');
    expect(keys).toContain('ch_worst_fn_count');
    // Window 'all', because a snapshot describes the tree at one commit — a
    // 30d window would imply a measurement over time nobody made.
    expect(metrics.every((m) => m.window === 'all')).toBe(true);
    expect(
      Number(metrics.find((m) => m.metricKey === 'ch_duplication_pct')?.value),
    ).toBeGreaterThan(0);

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.repoId, repoId));
    expect(run?.status).toBe('succeeded');
    expect(run?.toolVersions?.['lizard']).toBe('1.24.0');
    expect(run?.toolVersions?.['jscpd']).toBe('4.3.0');
  }, 900_000);

  it('re-running over the same commit creates ZERO new findings', async () => {
    const before = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    const result = await runCodeHealthScan({
      db,
      provider: fakeProvider([]),
      workspaceId,
      repoId,
      repo: 'acme/health',
      commitSha: SHA,
      image: scanImage as string,
    });
    expect(result.status).toBe('succeeded');
    expect(result.findingsCreated).toBe(0);
    const after = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(after.length).toBe(before.length);
  }, 900_000);

  it('a failing tool run leaves a FAILED scan_run, not a clean one', async () => {
    // NFR-15. The dangerous outcome is not a crash — it is a scan that reports
    // nothing and looks like a healthy repository.
    const result = await runCodeHealthScan({
      db,
      provider: fakeProvider([]),
      workspaceId,
      repoId,
      repo: 'acme/health',
      commitSha: 'w9-02-broken-sha',
      image: 'localhost/repopulse/does-not-exist:never',
      wallClockMs: 30_000,
    });
    expect(result.status).toBe('failed');

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.repoId, repoId),
          eq(security.scanRuns.commitSha, 'w9-02-broken-sha'),
        ),
      );
    expect(run?.status).toBe('failed');
    expect(run?.findingCount).toBe(0);
    expect(run?.error).toBeTruthy();
  }, 300_000);
});
