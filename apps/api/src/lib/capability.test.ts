import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { core, read, security, createDb, type Database } from '@repopulse/shared';
import { repoCapabilities, UNSUPPORTED_CAPABILITIES } from './capability.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

// The canonical capability producer (W17-10).
//
// The states that matter are the negative ones: "never looked" must not read
// like "looked and found nothing", and a failed run must not erase the evidence
// of an earlier good one.
describeIfDb('repoCapabilities (W17-10)', () => {
  let db: Database;
  let workspaceId: number;
  let otherWorkspaceId: number;
  let repoId: number;
  let otherRepoId: number;
  let connectionId: number;
  let otherConnectionId: number;

  const NOW = new Date('2026-09-08T12:00:00.000Z');
  const RECENT = new Date('2026-09-08T10:00:00.000Z'); // 2h before NOW
  const OLD = new Date('2026-09-01T12:00:00.000Z'); // 7d before NOW

  beforeAll(async () => {
    db = createDb(databaseUrl as string);

    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w17-10-a', name: 'W17-10 A' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'W17-10 A' } })
      .returning();
    workspaceId = ws!.id;

    const [other] = await db
      .insert(core.workspaces)
      .values({ slug: 'w17-10-b', name: 'W17-10 B' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'W17-10 B' } })
      .returning();
    otherWorkspaceId = other!.id;

    // A repo needs a connection (FK, notNull), so make one per workspace.
    const mkConnection = async (wsId: number, fp: string): Promise<number> => {
      const [c] = await db
        .insert(core.forgeConnections)
        .values({
          workspaceId: wsId,
          provider: 'github',
          authKind: 'pat',
          credentialCiphertext: Buffer.alloc(8),
          credentialIv: Buffer.alloc(12),
          keyVersion: 1,
          credentialFingerprint: fp,
          status: 'active',
        })
        .returning();
      return c!.id;
    };

    const mkRepo = async (wsId: number, connId: number, forgeRepoId: string, name: string) => {
      // Plain insert after a delete: the unique key is
      // (workspace_id, connection_id, forge_repo_id), which onConflict cannot
      // target by forge_repo_id alone.
      await db.delete(core.repos).where(eq(core.repos.forgeRepoId, forgeRepoId));
      const [r] = await db
        .insert(core.repos)
        .values({
          workspaceId: wsId,
          connectionId: connId,
          forgeRepoId,
          org: 'acme',
          name,
          defaultBranch: 'main',
          isPrivate: false,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        })
        .returning();
      return r!.id;
    };

    connectionId = await mkConnection(workspaceId, 'w17-10-fp-a');
    otherConnectionId = await mkConnection(otherWorkspaceId, 'w17-10-fp-b');
    repoId = await mkRepo(workspaceId, connectionId, 'w17-10-repo', 'w17-10');
    otherRepoId = await mkRepo(otherWorkspaceId, otherConnectionId, 'w17-10-other', 'other');
  });

  afterEach(async () => {
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(read.analysisRuns).where(eq(read.analysisRuns.repoId, repoId));
    await db.update(core.repos).set({ lastSyncedAt: null }).where(eq(core.repos.id, repoId));
  });

  afterAll(async () => {
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(read.analysisRuns).where(eq(read.analysisRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, otherRepoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.id, otherConnectionId));
    await db.$client.end();
  });

  const get = async () => repoCapabilities(db, workspaceId, repoId, { now: NOW });
  const cap = async (id: string) => (await get())?.capabilities.find((c) => c.id === id);

  async function addScanRun(v: {
    status: string;
    finishedAt?: Date | null;
    startedAt?: Date;
    commitSha?: string;
    scannerKey?: string;
  }): Promise<void> {
    await db.insert(security.scanRuns).values({
      workspaceId,
      repoId,
      scannerKey: v.scannerKey ?? 'secrets',
      scannerVersion: '1.0.0',
      commitSha: v.commitSha ?? 'abc123',
      trigger: 'manual',
      status: v.status,
      startedAt: v.startedAt ?? RECENT,
      finishedAt: v.finishedAt ?? null,
    });
  }

  it('a never-synced repository reports metadata as never measured, not as clean', async () => {
    const meta = await cap('metadata');
    expect(meta?.state).toBe('not_configured');
    expect(meta?.lastSuccessAt).toBeNull();
    // "never measured" is NOT "stale" — stale means we measured and it aged.
    expect(meta?.stale).toBe(false);
    expect(meta?.detail).toMatch(/never/i);
  });

  it('a recently synced repository is succeeded and fresh', async () => {
    await db.update(core.repos).set({ lastSyncedAt: RECENT }).where(eq(core.repos.id, repoId));
    const meta = await cap('metadata');
    expect(meta?.state).toBe('succeeded');
    expect(meta?.stale).toBe(false);
  });

  it('an old sync is STILL succeeded, and separately stale', async () => {
    // The two are independent by design: collapsing them would make one of the
    // facts unsayable.
    await db.update(core.repos).set({ lastSyncedAt: OLD }).where(eq(core.repos.id, repoId));
    const meta = await cap('metadata');
    expect(meta?.state).toBe('succeeded');
    expect(meta?.stale).toBe(true);
  });

  it('a completed scan with ZERO findings reads as succeeded, and says so', async () => {
    await addScanRun({ status: 'succeeded', finishedAt: RECENT });
    const secrets = await cap('secrets');
    expect(secrets?.state).toBe('succeeded');
    expect(secrets?.lastSuccessAt).toBe(RECENT.toISOString());
    // The distinction the whole module exists for.
    expect(secrets?.detail).toMatch(/not that nothing was looked at/i);
  });

  it('an OLD SUCCESS plus a NEW FAILURE exposes BOTH', async () => {
    // The single most important case. A failed run must never erase the
    // evidence of the earlier good one — those findings are still on screen.
    await addScanRun({
      status: 'succeeded',
      finishedAt: OLD,
      startedAt: OLD,
      commitSha: 'goodsha',
    });
    await addScanRun({
      status: 'failed',
      finishedAt: RECENT,
      startedAt: RECENT,
      commitSha: 'badsha',
    });

    const secrets = await cap('secrets');
    expect(secrets?.state).toBe('failed');
    expect(secrets?.lastSuccessAt).toBe(OLD.toISOString());
    // And the ref is the one from the SUCCESSFUL run, never the failed one.
    expect(secrets?.lastSuccessRef).toBe('goodsha');
    expect(secrets?.stale).toBe(true);
    expect(secrets?.detail).toMatch(/still shown and are still real/i);
  });

  it('a failure with no earlier success says exactly that', async () => {
    await addScanRun({ status: 'failed', finishedAt: RECENT });
    const secrets = await cap('secrets');
    expect(secrets?.state).toBe('failed');
    expect(secrets?.lastSuccessAt).toBeNull();
    expect(secrets?.lastSuccessRef).toBeNull();
    expect(secrets?.detail).toMatch(/no earlier successful run/i);
  });

  it('a running scan is running, not succeeded', async () => {
    await addScanRun({ status: 'running', finishedAt: null });
    expect((await cap('secrets'))?.state).toBe('running');
  });

  it('a queued scan is queued', async () => {
    await addScanRun({ status: 'queued', finishedAt: null });
    expect((await cap('secrets'))?.state).toBe('queued');
  });

  it('reports unshipped dimensions as NOT SUPPORTED, not as off or clean', async () => {
    // A reserved schema value is not a shipped capability. Showing coverage as
    // "off" would imply a switch the operator could flip.
    for (const id of Object.keys(UNSUPPORTED_CAPABILITIES)) {
      const c = await cap(id);
      expect(c?.state, `${id} should be not_supported`).toBe('not_supported');
      expect(c?.lastSuccessAt).toBeNull();
      expect(c?.detail).toMatch(/not implemented/i);
    }
  });

  it('AI review with no enabled model is not_configured and says it is OPTIONAL', async () => {
    const ai = await cap('ai_review');
    // No provider is enabled in this workspace.
    expect(ai?.state).toBe('not_configured');
    expect(ai?.detail).toMatch(/optional/i);
  });

  it('null timestamps and refs stay null — never a zero date or an empty string', async () => {
    const all = (await get())?.capabilities ?? [];
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      if (c.lastSuccessAt !== null) {
        expect(new Date(c.lastSuccessAt).getFullYear()).toBeGreaterThan(2000);
      }
      expect(c.lastSuccessRef === null || c.lastSuccessRef.length > 0).toBe(true);
    }
  });

  it('another workspace cannot read this repository — null, not a leak', async () => {
    expect(await repoCapabilities(db, otherWorkspaceId, repoId, { now: NOW })).toBeNull();
  });

  it('a repository id that does not exist returns null', async () => {
    expect(await repoCapabilities(db, workspaceId, 987654321, { now: NOW })).toBeNull();
  });

  it('the freshness threshold is reported, so the UI never hardcodes it', async () => {
    const result = await repoCapabilities(db, workspaceId, repoId, { now: NOW, freshnessHours: 1 });
    expect(result?.freshnessHours).toBe(1);
  });
});
