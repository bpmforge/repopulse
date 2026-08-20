import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { providerForRepo } from './forge-provider.js';

// Per-connection forge base URL (W14-02).
//
// The defect this closes: providerForRepo built a GitHubProvider for EVERY
// connection regardless of what the row said, so a Gitea connection would have
// ingested through GitHub's API shapes and failed in ways that read as a broken
// instance rather than as the wrong adapter.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const KEY = Buffer.alloc(32, 7);

describeIfLiveInfra('providerForRepo', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  const repos: Record<string, number> = {};
  const fingerprints: string[] = [];

  const connect = async (
    provider: 'github' | 'gitea',
    baseUrl: string | null,
    userId: number,
    tag: string,
  ): Promise<number> => {
    const enc = credentials.encryptCredential(`token-${tag}`, KEY);
    fingerprints.push(enc.fingerprint);
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider,
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
        createdBy: userId,
        baseUrl,
      })
      .returning();

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: `w14-02-${tag}`,
        org: 'acme',
        name: tag,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repos[tag] = repo!.id;
    return conn!.id;
  };

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w14-02-user', forgeUserId: 'w14-02-user', login: 'w14-02-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w14-02-user' } })
      .returning();

    await connect('gitea', 'https://git.example.com', user!.id, 'gitea');
    await connect('github', null, user!.id, 'github-legacy');
    // A SECOND legacy row, untouched until the backfill test: resolving a row
    // stamps it, so a shared fixture would already carry the default by the
    // time that test ran and would have proved nothing.
    await connect('github', null, user!.id, 'github-backfill');
  });

  afterAll(async () => {
    for (const id of Object.values(repos)) {
      await db.delete(core.repos).where(eq(core.repos.id, id));
    }
    for (const fingerprint of fingerprints) {
      await db
        .delete(core.forgeConnections)
        .where(eq(core.forgeConnections.credentialFingerprint, fingerprint));
    }
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w14-02-user'));
  });

  it('builds a GITEA provider for a Gitea connection', async () => {
    const resolved = await providerForRepo({ db, tokenKey: KEY }, workspaceId, repos.gitea!);
    expect(resolved?.provider.constructor.name).toBe('GiteaProvider');
  });

  it('builds a GitHub provider for a GitHub connection, in the same workspace', async () => {
    // The acceptance in one assertion: two forges, one workspace, each getting
    // its own adapter.
    const resolved = await providerForRepo({ db, tokenKey: KEY }, workspaceId, repos['github-legacy']!);
    expect(resolved?.provider.constructor.name).toBe('GitHubProvider');
  });

  it('BACKFILLS a legacy connection with the base URL it was created under', async () => {
    // The row was written before W14-02 and has no base_url. Resolving it once
    // stamps the server default onto it, so a later change to FORGE_BASE_URL
    // does not silently move a connection made against a different host.
    await providerForRepo(
      { db, tokenKey: KEY, forgeBaseUrl: 'https://ghe.acme.example' },
      workspaceId,
      repos['github-backfill']!,
    );

    const [repo] = await db
      .select({ connectionId: core.repos.connectionId })
      .from(core.repos)
      .where(eq(core.repos.id, repos['github-backfill']!));
    const [conn] = await db
      .select({ baseUrl: core.forgeConnections.baseUrl })
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, repo!.connectionId));

    expect(conn!.baseUrl).toBe('https://ghe.acme.example');
  });

  it('leaves an explicit per-connection URL alone', async () => {
    await providerForRepo(
      { db, tokenKey: KEY, forgeBaseUrl: 'https://ghe.acme.example' },
      workspaceId,
      repos.gitea!,
    );
    const [repo] = await db
      .select({ connectionId: core.repos.connectionId })
      .from(core.repos)
      .where(eq(core.repos.id, repos.gitea!));
    const [conn] = await db
      .select({ baseUrl: core.forgeConnections.baseUrl })
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, repo!.connectionId));

    // The server default must not overwrite what the connection declared.
    expect(conn!.baseUrl).toBe('https://git.example.com');
  });
});
