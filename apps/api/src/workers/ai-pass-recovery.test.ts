import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, read } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERRUPTED_CODE, aiPassBootRecoveryOn, recoverAiPassRuns } from './ai-pass-recovery.js';

// W27-22. A worker that stops mid-pass leaves the row `running` for ever and
// may lose a `pending` row's queue entry. Against the real table: the sweep
// closes the first in words, queues the second again, touches nothing that is
// finished, and stays inside each workspace.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

describe('AI_PASS_BOOT_RECOVERY', () => {
  it('is on unless switched off', () => {
    expect(aiPassBootRecoveryOn({})).toBe(true);
    expect(aiPassBootRecoveryOn({ AI_PASS_BOOT_RECOVERY: 'on' })).toBe(true);
    expect(aiPassBootRecoveryOn({ AI_PASS_BOOT_RECOVERY: ' OFF ' })).toBe(false);
  });
});

describeIfLiveInfra('AI pass recovery on boot (W27-22)', () => {
  const db = createDb(databaseUrl as string);
  let WS = 0;
  let OTHER = 0;
  let REPO = 0;
  let OTHER_REPO = 0;
  const NOW = new Date('2026-11-18T23:00:00Z');

  async function ws(slug: string) {
    await db.insert(core.workspaces).values({ slug, name: slug }).onConflictDoNothing();
    return (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
  }
  async function repoIn(workspaceId: number, name: string) {
    await db.delete(core.repos).where(eq(core.repos.forgeRepoId, `w27-22-${name}`));
    const enc = credentials.encryptCredential('w27-22-token', Buffer.alloc(32, 7));
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
      })
      .returning({ id: core.forgeConnections.id });
    const [r] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: `w27-22-${name}`,
        org: 'w27-22',
        name,
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    return r!.id;
  }
  async function run(workspaceId: number, repoId: number, status: string, mode = 'paths') {
    const [r] = await db
      .insert(read.aiPassRuns)
      .values({
        workspaceId,
        repoId,
        paths: [],
        mode: mode as 'paths',
        status,
        ...(status === 'running' ? { startedAt: new Date('2026-11-18T22:30:00Z') } : {}),
      })
      .returning({ id: read.aiPassRuns.id });
    return r!.id;
  }
  const statusOf = async (id: number) =>
    (
      await db
        .select({
          status: read.aiPassRuns.status,
          reasonCode: read.aiPassRuns.reasonCode,
          reason: read.aiPassRuns.reason,
          finishedAt: read.aiPassRuns.finishedAt,
        })
        .from(read.aiPassRuns)
        .where(eq(read.aiPassRuns.id, id))
    )[0]!;

  beforeAll(async () => {
    WS = await ws('w27-22-ws');
    OTHER = await ws('w27-22-other');
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, WS));
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, OTHER));
    REPO = await repoIn(WS, 'recover');
    OTHER_REPO = await repoIn(OTHER, 'recover-other');
  });
  beforeEach(async () => {
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, WS));
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, OTHER));
  });
  afterAll(async () => {
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, WS));
    await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, OTHER));
    await db.$client.end();
  });

  it('closes running passes as interrupted and queues pending ones again', async () => {
    const firstLook = await run(WS, REPO, 'running');
    const judge = await run(WS, REPO, 'pending', 'judge');
    const done = await run(WS, REPO, 'succeeded');
    const failed = await run(WS, REPO, 'failed');
    const enqueue = vi.fn(async () => {});

    const result = await recoverAiPassRuns({
      db,
      enqueue,
      now: () => NOW,
      onlyWorkspaces: [WS, OTHER],
    });

    expect(result).toEqual({ interrupted: [firstLook], requeued: [judge] });
    expect(await statusOf(firstLook)).toMatchObject({
      status: 'failed',
      reasonCode: INTERRUPTED_CODE,
      finishedAt: NOW,
    });
    expect((await statusOf(firstLook)).reason).toMatch(/worker stopped/);
    expect((await statusOf(judge)).status).toBe('pending');
    expect((await statusOf(done)).status).toBe('succeeded');
    expect((await statusOf(failed)).reasonCode).toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ workspaceId: WS, runId: judge }, NOW.getTime());
  });

  it('keeps each queue entry in the workspace that owns the run', async () => {
    const mine = await run(WS, REPO, 'pending');
    const theirs = await run(OTHER, OTHER_REPO, 'pending');
    const theirRunning = await run(OTHER, OTHER_REPO, 'running', 'judge');
    const enqueue = vi.fn(async () => {});

    const result = await recoverAiPassRuns({
      db,
      enqueue,
      now: () => NOW,
      onlyWorkspaces: [WS, OTHER],
    });

    expect(result.interrupted).toEqual([theirRunning]);
    expect(result.requeued.sort()).toEqual([mine, theirs].sort());
    expect(enqueue).toHaveBeenCalledWith({ workspaceId: WS, runId: mine }, NOW.getTime());
    expect(enqueue).toHaveBeenCalledWith({ workspaceId: OTHER, runId: theirs }, NOW.getTime());
  });

  it('does nothing when no pass is open', async () => {
    await run(WS, REPO, 'succeeded');
    const enqueue = vi.fn(async () => {});
    const result = await recoverAiPassRuns({ db, enqueue, onlyWorkspaces: [WS, OTHER] });
    expect(result).toEqual({ interrupted: [], requeued: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
