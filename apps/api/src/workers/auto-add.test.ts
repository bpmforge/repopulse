import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { core, createDb, type Database } from '@repopulse/shared';
import type { ForgeProvider, ForgeRepo } from '@repopulse/forge';
import { autoAddNewRepos } from './auto-add.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// W20-17 (UX_TODO INS-09): "Track all and auto-add new" tracks repositories
// created after the choice, found by the nightly sweep.

function forgeRepo(id: string, name: string, archived = false): ForgeRepo {
  return {
    externalId: id,
    name,
    fullName: `acme/${name}`,
    defaultBranch: 'main',
    isPrivate: true,
    isArchived: archived,
    pushedAt: null,
  } as unknown as ForgeRepo;
}

describeIfLiveInfra('auto-add new repositories (W20-17, INS-09)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let optedIn: number;
  let notOptedIn: number;

  async function connection(fp: string): Promise<number> {
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: fp,
        status: 'active',
      })
      .returning();
    return conn!.id;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w20-17-auto-add', name: 'w20-17-auto-add' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w20-17-auto-add' } })
      .returning();
    workspaceId = ws!.id;
    optedIn = await connection('w20-17-aa-1');
    notOptedIn = await connection('w20-17-aa-2');
    await db
      .update(core.workspaces)
      .set({ settings: { auto_add_connection_ids: [optedIn], unrelated: 'kept' } })
      .where(eq(core.workspaces.id, workspaceId));
    // Already tracked, and paused: auto-add must not touch it.
    await db.insert(core.repos).values({
      workspaceId,
      connectionId: optedIn,
      forgeRepoId: '1',
      org: 'acme',
      name: 'old',
      defaultBranch: 'main',
      isPrivate: true,
      isArchived: false,
      syncStatus: 'paused',
      tier2Auto: false,
    });
  });

  afterAll(async () => {
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('tracks only new, unarchived repositories on opted-in connections', async () => {
    const registerWebhook = vi.fn(() => Promise.resolve('hook'));
    const provider = {
      listRepos: () =>
        Promise.resolve({
          items: [forgeRepo('1', 'old'), forgeRepo('2', 'new'), forgeRepo('3', 'gone', true)],
        }),
      registerWebhook,
      capabilities: { webhookScheme: 'hub-signature' },
    } as unknown as ForgeProvider;
    const providerFor = vi.fn(() => Promise.resolve(provider));
    const enqueuePlan = vi.fn(() => Promise.resolve());

    const result = await autoAddNewRepos(
      {
        db,
        webhookUrl: 'https://rp.example.com/api/v1/webhooks/github',
        tokenKeySeal: (pt) => Buffer.from(pt),
        tokenKeyOpen: (b) => b.toString(),
        providerFor,
        enqueuePlan,
      },
      workspaceId,
    );

    expect(result).toEqual({ connections: 1, added: 1, failed: [] });
    expect(providerFor).toHaveBeenCalledWith(workspaceId, optedIn);
    expect(providerFor).not.toHaveBeenCalledWith(workspaceId, notOptedIn);
    expect(registerWebhook).toHaveBeenCalledTimes(1);
    expect((registerWebhook.mock.calls[0] as unknown[])[1]).toBe('acme/new');
    expect(enqueuePlan).toHaveBeenCalledTimes(1);

    const rows = await db
      .select({ name: core.repos.name, status: core.repos.syncStatus })
      .from(core.repos)
      .where(and(eq(core.repos.workspaceId, workspaceId), eq(core.repos.connectionId, optedIn)));
    expect(rows.map((r) => r.name).sort()).toEqual(['new', 'old']);
    expect(rows.find((r) => r.name === 'old')?.status).toBe('paused');
  });

  // W20-19 (UX_TODO INS-09 purge, INS-69; decision 2026-10-20).
  it('skips purged repositories and registers no hook on a scheduled-sync-only connection', async () => {
    await db
      .update(core.workspaces)
      .set({
        settings: {
          auto_add_connection_ids: [optedIn],
          scheduled_sync_only_connection_ids: [optedIn],
          auto_add_skip: { [String(optedIn)]: ['4'] },
        },
      })
      .where(eq(core.workspaces.id, workspaceId));
    const registerWebhook = vi.fn(() => Promise.resolve('hook'));
    const provider = {
      listRepos: () =>
        Promise.resolve({ items: [forgeRepo('4', 'purged'), forgeRepo('5', 'quiet')] }),
      registerWebhook,
      capabilities: { webhookScheme: 'hub-signature' },
    } as unknown as ForgeProvider;
    try {
      const result = await autoAddNewRepos(
        {
          db,
          webhookUrl: 'https://rp.example.com/api/v1/webhooks/github',
          tokenKeySeal: (pt) => Buffer.from(pt),
          tokenKeyOpen: (b) => b.toString(),
          providerFor: () => Promise.resolve(provider),
          enqueuePlan: () => Promise.resolve(),
        },
        workspaceId,
      );
      expect(result).toMatchObject({ added: 1, failed: [] });
      expect(registerWebhook).not.toHaveBeenCalled();
      const names = (
        await db
          .select({ name: core.repos.name })
          .from(core.repos)
          .where(eq(core.repos.workspaceId, workspaceId))
      ).map((r) => r.name);
      expect(names).toContain('quiet');
      expect(names).not.toContain('purged');
    } finally {
      await db
        .update(core.workspaces)
        .set({ settings: { auto_add_connection_ids: [optedIn], unrelated: 'kept' } })
        .where(eq(core.workspaces.id, workspaceId));
    }
  });

  it('reports a failing connection without throwing', async () => {
    const result = await autoAddNewRepos(
      {
        db,
        webhookUrl: 'https://rp.example.com/api/v1/webhooks/github',
        tokenKeySeal: (pt) => Buffer.from(pt),
        tokenKeyOpen: (b) => b.toString(),
        providerFor: () => Promise.reject(new Error('HTTP 401')),
        enqueuePlan: () => Promise.resolve(),
      },
      workspaceId,
    );
    expect(result.added).toBe(0);
    expect(result.failed).toEqual([{ connectionId: optedIn, error: 'HTTP 401' }]);
  });
});
