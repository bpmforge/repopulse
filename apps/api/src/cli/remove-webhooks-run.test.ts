import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { removeWebhooks } from './remove-webhooks-run.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// `pnpm remove:webhooks` (W20-15, UX_TODO X-27): the first step of uninstall.
// Leaving the hooks behind makes every tracked repository send deliveries that
// fail to a server that no longer exists. Scoped to a workspace of its own,
// because the database is shared with other suites.
describeIfLiveInfra('removeWebhooks (W20-15)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  const repoIds: Record<string, number> = {};

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w20-15-uninstall', name: 'Uninstall' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Uninstall' } })
      .returning();
    workspaceId = ws!.id;
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    const conn = async (provider: 'github' | 'gitlab', status: string, fp: string) =>
      (
        await db
          .insert(core.forgeConnections)
          .values({
            workspaceId,
            provider,
            authKind: 'pat',
            credentialCiphertext: Buffer.from('x'),
            credentialIv: Buffer.from('iv-1234567890123'),
            keyVersion: 1,
            credentialFingerprint: fp,
            status,
          })
          .returning()
      )[0]!.id;
    const gh = await conn('github', 'active', 'w20-15-gh');
    const gl = await conn('gitlab', 'active', 'w20-15-gl');
    const gone = await conn('github', 'revoked', 'w20-15-gone');
    const repo = async (connectionId: number, name: string, syncStatus = 'live') => {
      const [r] = await db
        .insert(core.repos)
        .values({
          workspaceId,
          connectionId,
          forgeRepoId: `w20-15-${name}`,
          org: 'acme',
          name,
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
          syncStatus,
          tier2Auto: false,
        })
        .returning();
      repoIds[name] = r!.id;
    };
    await repo(gh, 'api');
    await repo(gh, 'paused-one', 'paused');
    await repo(gl, 'web');
    await repo(gone, 'old');
  });

  afterAll(async () => {
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.$client.end();
  });

  it('removes our hook on every tracked repository, at the URL each forge was given', async () => {
    const calls: { repo: string; url: string }[] = [];
    const fake = (scheme: 'hub-signature' | 'gitlab-token'): ForgeProvider =>
      ({
        capabilities: { webhookScheme: scheme },
        deleteWebhooks: async (_ctx: unknown, repo: string, url: string) => {
          calls.push({ repo, url });
          return 1;
        },
      }) as unknown as ForgeProvider;
    const result = await removeWebhooks(db, {
      webhookUrl: 'https://rp.example/api/v1/webhooks/github',
      providerFor: async (ws, repoId) => {
        if (ws !== workspaceId) return null;
        if (repoId === repoIds['web']) {
          return { provider: fake('gitlab-token'), repoFullName: 'acme/web' };
        }
        if (repoId === repoIds['api'] || repoId === repoIds['paused-one']) {
          const name = repoId === repoIds['api'] ? 'acme/api' : 'acme/paused-one';
          return { provider: fake('hub-signature'), repoFullName: name };
        }
        return null;
      },
    });
    const mine = calls.filter((c) => c.repo.startsWith('acme/'));
    expect(mine).toEqual(
      expect.arrayContaining([
        { repo: 'acme/api', url: 'https://rp.example/api/v1/webhooks/github' },
        { repo: 'acme/paused-one', url: 'https://rp.example/api/v1/webhooks/github' },
        { repo: 'acme/web', url: 'https://rp.example/api/v1/webhooks/gitlab' },
      ]),
    );
    // A revoked connection's repository is not attempted: its token is gone.
    expect(mine.map((c) => c.repo)).not.toContain('acme/old');
    expect(result.removed).toBeGreaterThanOrEqual(3);
  });

  it('names a repository it could not clean up instead of failing the rest', async () => {
    const result = await removeWebhooks(db, {
      webhookUrl: 'https://rp.example/api/v1/webhooks/github',
      providerFor: async (ws, repoId) =>
        ws === workspaceId && repoId === repoIds['api']
          ? {
              provider: {
                capabilities: { webhookScheme: 'hub-signature' },
                deleteWebhooks: async () => {
                  throw new Error('forge responded 403');
                },
              } as unknown as ForgeProvider,
              repoFullName: 'acme/api',
            }
          : null,
    });
    expect(result.failed).toEqual(
      expect.arrayContaining([{ repo: 'acme/api', error: 'forge responded 403' }]),
    );
  });
});
