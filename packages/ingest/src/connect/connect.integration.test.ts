import 'dotenv/config';
import { createCipheriv, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import type { ForgeRepo } from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activateRepos,
  createConnection,
  ConnectValidationError,
  type EncryptedBlob,
} from './connect.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// Real AES-256-GCM here (node:crypto directly) rather than importing the auth
// vault — ARCHITECTURE §3 forbids ingest→auth even in tests. Enough to prove
// the stored blob carries no plaintext; the vault's own guarantees live in
// packages/auth/src/credentials/vault.test.ts.
const KEY = randomBytes(32);
function encrypt(plaintext: string): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([cipher.getAuthTag(), enc]),
    iv,
    keyVersion: 1,
    fingerprint: `${plaintext.slice(-4)}:hash`,
  };
}

// Self-contained seal (iv‖tag‖ct) for the single-column webhook secret.
function sealSecret(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

const REPOS: ForgeRepo[] = [
  {
    externalId: '101',
    name: 'alpha',
    fullName: 'acme/alpha',
    defaultBranch: 'main',
    isPrivate: true,
    isArchived: false,
    pushedAt: '2026-07-01T00:00:00Z',
    htmlUrl: '',
  },
  {
    externalId: '102',
    name: 'beta',
    fullName: 'acme/beta',
    defaultBranch: 'main',
    isPrivate: true,
    isArchived: false,
    pushedAt: '2026-06-01T00:00:00Z',
    htmlUrl: '',
  },
  {
    externalId: '103',
    name: 'gamma',
    fullName: 'acme/gamma',
    defaultBranch: 'main',
    isPrivate: false,
    isArchived: false,
    pushedAt: null,
    htmlUrl: '',
  },
];

const TOKEN = 'ghp_connectFlowSecretTokenABCDEFGH1234567890';

describeIfLiveInfra('connect flow (W2-01, FR-INGEST-1)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let createdBy: number;
  const connectionIds: number[] = [];

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w2-01-connect', name: 'w2-01-connect' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w2-01-connect' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w2-01-user', forgeUserId: 'w2-01-user', login: 'w2-01-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w2-01-user' } })
      .returning();
    createdBy = user!.id;
  });

  afterAll(async () => {
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w2-01-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('classifies a 401 as bad_token and a 403 as bad_scope (distinct actionable errors)', async () => {
    const base = {
      workspaceId,
      provider: 'github' as const,
      authKind: 'pat' as const,
      credential: TOKEN,
      createdBy,
    };
    await expect(
      createConnection(
        { db, encrypt, smokeListRepos: () => Promise.reject({ status: 401 }) },
        base,
      ),
    ).rejects.toMatchObject({ kind: 'bad_token' });
    await expect(
      createConnection(
        { db, encrypt, smokeListRepos: () => Promise.reject({ status: 403 }) },
        base,
      ),
    ).rejects.toMatchObject({ kind: 'bad_scope' });
  });

  it('rejects a credential that can see no repos', async () => {
    await expect(
      createConnection(
        { db, encrypt, smokeListRepos: () => Promise.resolve([]) },
        { workspaceId, provider: 'github', authKind: 'pat', credential: TOKEN, createdBy },
      ),
    ).rejects.toBeInstanceOf(ConnectValidationError);
  });

  it('creates an encrypted connection row (no plaintext) and returns candidates', async () => {
    const result = await createConnection(
      { db, encrypt, smokeListRepos: () => Promise.resolve(REPOS) },
      { workspaceId, provider: 'github', authKind: 'pat', credential: TOKEN, createdBy },
    );
    connectionIds.push(result.connectionId);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toMatchObject({ forgeRepoId: '101', org: 'acme', name: 'alpha' });

    const [row] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, result.connectionId));
    // DB-dump grep: the token never appears in the stored ciphertext/fingerprint.
    expect(row!.credentialCiphertext.toString('latin1')).not.toContain(TOKEN);
    expect(row!.credentialFingerprint).not.toContain(TOKEN);
    expect(row!.credentialFingerprint.startsWith('7890:')).toBe(true);
    expect(row!.status).toBe('active');
  });

  it('activates selected repos: pending_backfill rows, one webhook + plan per repo, secret stored encrypted', async () => {
    const created = await createConnection(
      { db, encrypt, smokeListRepos: () => Promise.resolve(REPOS) },
      { workspaceId, provider: 'github', authKind: 'pat', credential: TOKEN, createdBy },
    );
    connectionIds.push(created.connectionId);

    const registerWebhook = vi.fn(async () => 'hook-1');
    const enqueuePlan = vi.fn(async () => {});
    const repoIds = await activateRepos(
      { db, sealSecret, registerWebhook, enqueuePlan, generateSecret: () => 'wh-secret' },
      {
        workspaceId,
        connectionId: created.connectionId,
        candidates: created.candidates,
        selection: { forgeRepoIds: ['101', '102'] },
      },
    );

    expect(repoIds).toHaveLength(2);
    expect(registerWebhook).toHaveBeenCalledTimes(2);
    expect(registerWebhook).toHaveBeenCalledWith('acme/alpha', 'wh-secret');
    expect(enqueuePlan).toHaveBeenCalledTimes(2);

    const rows = await db
      .select()
      .from(core.repos)
      .where(eq(core.repos.connectionId, created.connectionId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.syncStatus === 'pending_backfill')).toBe(true);

    const [conn] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, created.connectionId));
    expect(conn!.webhookSecretCiphertext, 'webhook secret stored encrypted').toBeTruthy();
    expect(conn!.webhookSecretCiphertext!.toString('latin1')).not.toContain('wh-secret');
  });

  it('a repo whose webhook cannot be registered STILL gets backfilled', async () => {
    // The case that made this non-fatal: a PUBLIC repo the operator does not
    // administer (hook creation needs admin; reading does not imply it), and a
    // SELF-HOSTED install with no publicly reachable URL (D1a). Previously the
    // throw escaped after the repo row was inserted but BEFORE enqueuePlan, so
    // the repo sat in pending_backfill with no work queued — stuck silently and
    // forever. Webhooks are a freshness optimisation; backfill plus the nightly
    // reconcile sweep still produce correct data without them.
    const created = await createConnection(
      { db, encrypt, smokeListRepos: () => Promise.resolve(REPOS) },
      { workspaceId, provider: 'github', authKind: 'pat', credential: TOKEN, createdBy },
    );
    connectionIds.push(created.connectionId);

    const registerWebhook = vi.fn(async () => {
      throw new Error('forge responded 403');
    });
    const enqueuePlan = vi.fn(async () => {});
    const repoIds = await activateRepos(
      { db, sealSecret, registerWebhook, enqueuePlan, generateSecret: () => 'wh-secret' },
      {
        workspaceId,
        connectionId: created.connectionId,
        candidates: created.candidates,
        selection: { forgeRepoIds: ['101', '102'] },
      },
    );

    // Both repos are activated and BOTH have backfill work queued — the point.
    expect(repoIds).toHaveLength(2);
    expect(enqueuePlan).toHaveBeenCalledTimes(2);

    const rows = await db
      .select()
      .from(core.repos)
      .where(eq(core.repos.connectionId, created.connectionId));
    expect(rows.every((r) => r.syncStatus === 'pending_backfill')).toBe(true);
    // Degraded, but VISIBLY so: silently falling back to polling would leave an
    // operator wondering why updates lag.
    expect(rows.every((r) => (r.lastError ?? '').includes('live updates unavailable'))).toBe(true);
    expect(rows[0]!.lastError).toContain('403');
  });

  it('"all + auto-add" selects every candidate', async () => {
    const created = await createConnection(
      { db, encrypt, smokeListRepos: () => Promise.resolve(REPOS) },
      { workspaceId, provider: 'github', authKind: 'pat', credential: TOKEN, createdBy },
    );
    connectionIds.push(created.connectionId);
    const repoIds = await activateRepos(
      {
        db,
        sealSecret,
        registerWebhook: async () => 'h',
        enqueuePlan: async () => {},
        generateSecret: () => 's',
      },
      {
        workspaceId,
        connectionId: created.connectionId,
        candidates: created.candidates,
        selection: { allAutoAdd: true },
      },
    );
    expect(repoIds).toHaveLength(3);
  });
});
