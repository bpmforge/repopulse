import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import { readChurnTouches } from '@repopulse/metrics';
import { buildApp } from '../../../app.js';
import { loginAs } from '../../../testing/login.js';

const CSRF = { 'x-requested-with': 'repopulse' };
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

// Identity admin (W5-05).
//
// The assertion that matters is not "the endpoint returns 200" — it is that a
// merge CHANGES THE NUMBERS. `merged_into_id` existed in the schema from the
// start and was referenced nowhere: merging was a no-op, and every screen
// would have kept showing one person as two.

describeIfLiveInfra('admin identities (W5-05, FR-AUTH-4 / FR-METRICS-3)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let repoId: number;
  let aliceId: number;
  let aliceEmailId: number;
  let botId: number;

  const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const WINDOW = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      if (req.url?.startsWith('/login/oauth/access_token')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const code =
            (JSON.parse(Buffer.concat(chunks).toString() || '{}') as { code?: string }).code ??
            'tok';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: code, token_type: 'bearer' }));
        });
        return;
      }
      if (req.url === '/user') {
        const f = (req.headers.authorization ?? '').replace('Bearer ', '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: f, login: f, name: null, avatar_url: null }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => githubMock.listen(0, r));
    const addr = githubMock.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock bind failed');
    const ghBase = `http://127.0.0.1:${addr.port}`;

    app = buildApp({
      db,
      tokenKey: Buffer.alloc(32),
      webhookUrl: 'http://localhost/hook',
      redisUrl: redisUrl as string,
      sessionSecret: 'w5-05-session-secret-that-is-long-enough-here',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: {
        tokenUrl: `${ghBase}/login/oauth/access_token`,
        userUrl: `${ghBase}/user`,
      },
      loginRedirectUrl: 'http://localhost/',
    });
    await app.ready();

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
        authSubject: 'w5-05-owner',
        forgeUserId: 'w5-05-owner',
        login: 'w5-05-owner',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w5-05-owner' } })
      .returning();
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'w5-05-fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w5-05-repo',
        org: 'acme',
        name: 'identities',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    // The same human, twice: an account and an email-only commit author
    // (FORGE_PROVIDER §1 — commits whose author GitHub cannot resolve).
    const mk = async (login: string) => {
      const [row] = await db
        .insert(core.identities)
        .values({
          workspaceId,
          provider: 'github',
          forgeLogin: login,
          displayName: 'Alice Example',
        })
        .returning();
      return row!.id;
    };
    aliceId = await mk('w5-05-alice');
    aliceEmailId = await mk('alice@example.com');
    botId = await mk('w5-05-renovate');

    // 30 lines under the account, 12 under the email address.
    let sha = 0;
    for (const [identityId, additions] of [
      [aliceId, 20],
      [aliceEmailId, 12],
    ] as const) {
      const [c] = await db
        .insert(facts.commits)
        .values({
          workspaceId,
          repoId,
          sha: `w5-05-${sha++}`,
          authorIdentityId: identityId,
          committerIdentityId: identityId,
          authoredAt: RECENT,
          committedAt: RECENT,
          messageHead: 'work',
          isRevertHeuristic: false,
          isMerge: false,
        })
        .returning();
      await db.insert(facts.commitFiles).values({
        workspaceId,
        repoId,
        commitId: c!.id,
        path: 'src/app.ts',
        additions,
        deletions: 0,
        status: 'modified',
      });
    }
  });

  afterAll(async () => {
    await db.delete(facts.commitFiles).where(eq(facts.commitFiles.repoId, repoId));
    await db.delete(facts.commits).where(eq(facts.commits.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, 'w5-05-fp'));
    for (const id of [aliceEmailId, botId, aliceId]) {
      await db
        .update(core.identities)
        .set({ mergedIntoId: null })
        .where(eq(core.identities.id, id));
    }
    await db
      .delete(core.identities)
      .where(
        and(
          eq(core.identities.workspaceId, workspaceId),
          eq(core.identities.displayName, 'Alice Example'),
        ),
      );
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w5-05-owner'));
    // Leaves no extra workspace admin behind: a suite that does breaks the
    // last-admin assertion in a file it never touched (learned in W4-09).
    await db
      .delete(core.workspaceMembers)
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          eq(core.workspaceMembers.userId, adminUserId),
        ),
      );
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w5-05-admin'));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
    await db.$client.end();
  });

  let adminUserId: number;
  async function adminSession(): Promise<string> {
    const cookie = await loginAs(app, 'w5-05-admin');
    const [u] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, 'w5-05-admin'));
    adminUserId = u!.id;
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: adminUserId, role: 'admin' })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role: 'admin' },
      });
    return cookie;
  }

  it('lists identities with their commit weight and flags email fallbacks', async () => {
    const cookie = await adminSession();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/identities',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const items = (
      res.json() as {
        items: { id: number; login: string; commits: number; email_fallback: boolean }[];
      }
    ).items;
    expect(items.find((i) => i.login === 'w5-05-alice')?.commits).toBe(1);
    // The whole reason this screen exists: an email-only author is a person we
    // could not resolve, not a real account.
    expect(items.find((i) => i.login === 'alice@example.com')?.email_fallback).toBe(true);
    expect(items.find((i) => i.login === 'w5-05-alice')?.email_fallback).toBe(false);
  });

  it('searches and pages on the server, with totals (W20-22, UX_TODO X-17)', async () => {
    const cookie = await adminSession();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/identities?q=W5-05-&limit=1&offset=0',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: { login: string }[];
      total: number;
      all: number;
      providers: string[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.all).toBeGreaterThanOrEqual(3);
    expect(body.providers.length).toBeGreaterThan(0);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/identities?limit=0',
      cookies: { repopulse_sid: cookie },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('a merge REUNIFIES churn attribution — the numbers move, not just the row', async () => {
    const cookie = await adminSession();

    const before = (await readChurnTouches(db, repoId, WINDOW)).filter(
      (t) => t.path === 'src/app.ts',
    );
    const beforeLogins = new Set(before.map((t) => t.authorLogin));
    // Split across two identities to start with: 20 lines and 12 lines.
    expect(beforeLogins).toEqual(new Set(['w5-05-alice', 'alice@example.com']));

    const merge = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/identities/${aliceEmailId}/merge`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { into_id: aliceId },
    });
    expect(merge.statusCode).toBe(200);

    const after = (await readChurnTouches(db, repoId, WINDOW)).filter(
      (t) => t.path === 'src/app.ts',
    );
    const afterLogins = new Set(after.map((t) => t.authorLogin));
    // One person now. This is the assertion the whole ticket exists for: if the
    // readers did not resolve merged_into_id, this set would still have two
    // entries and every ownership/bus-factor number would still be split.
    expect(afterLogins).toEqual(new Set(['w5-05-alice']));
    expect(after.reduce((s, t) => s + t.additions, 0)).toBe(32);

    // W20-22 (UX_TODO ADM-70): the file page's live Owners query follows the
    // merge at once — one owner, not two with split shares.
    const file = await app.inject({
      method: 'GET',
      url: `/api/v1/repos/${repoId}/files/src/app.ts`,
      cookies: { repopulse_sid: cookie },
    });
    expect(file.statusCode).toBe(200);
    const owners = (file.json() as { owners: { login: string }[] }).owners;
    expect(owners.map((o) => o.login)).toEqual(['w5-05-alice']);
  });

  it('is reversible — undo restores the separate attribution', async () => {
    const cookie = await adminSession();
    const undo = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/identities/${aliceEmailId}/merge`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { into_id: null },
    });
    expect(undo.statusCode).toBe(200);
    const logins = new Set((await readChurnTouches(db, repoId, WINDOW)).map((t) => t.authorLogin));
    // Non-destructive (DATABASE.md §2): the commits were never rewritten, so
    // undoing gives the original attribution back rather than an empty author.
    expect(logins).toContain('alice@example.com');
  });

  it('refuses to merge an identity into itself, and refuses a second hop', async () => {
    const cookie = await adminSession();
    const self = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/identities/${aliceId}/merge`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { into_id: aliceId },
    });
    expect(self.statusCode).toBe(400);

    // alice-email -> alice, then try alice -> bot. The readers resolve exactly
    // one hop, so allowing this would make alice-email's churn vanish from
    // every screen rather than follow the chain.
    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/identities/${aliceEmailId}/merge`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { into_id: aliceId },
    });
    const chain = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/identities/${aliceId}/merge`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { into_id: botId },
    });
    expect(chain.statusCode).toBe(409);
  });

  // W20-10 (UX_TODO INS-51): an OIDC/local member has no forge account, so
  // "my" screens stayed empty for good until an admin could link them.
  it('links an identity to a member, moves an earlier link, and unlinks', async () => {
    const cookie = await adminSession();
    const [person] = await db
      .insert(core.users)
      .values({ authProvider: 'oidc', authSubject: 'w20-10-oidc-person', login: 'w20-10-person' })
      .returning();
    const personId = person!.id;
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: personId, role: 'member' });
    const [withForge] = await db
      .insert(core.identities)
      .values({
        workspaceId,
        provider: 'github',
        forgeLogin: 'w20-10-committer',
        forgeUserId: 'w20-10-fid',
        displayName: 'Alice Example',
      })
      .returning();
    const link = (identityId: number, userId: number | null | string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/admin/identities/${identityId}/link`,
        cookies: { repopulse_sid: cookie },
        headers: CSRF,
        payload: { user_id: userId },
      });
    const linkedTo = async (identityId: number) =>
      (
        await db
          .select({ userId: core.identities.userId })
          .from(core.identities)
          .where(eq(core.identities.id, identityId))
      )[0]!.userId;

    try {
      expect((await link(aliceEmailId, personId)).statusCode).toBe(200);
      expect(await linkedTo(aliceEmailId)).toBe(personId);

      // A forge-backed identity also links the account's forge id; the
      // member's earlier link moves rather than leaving two.
      const res = await link(withForge!.id, personId);
      expect(res.statusCode).toBe(200);
      expect(await linkedTo(withForge!.id)).toBe(personId);
      expect(await linkedTo(aliceEmailId)).toBeNull();
      const [u] = await db
        .select({ forgeUserId: core.users.forgeUserId })
        .from(core.users)
        .where(eq(core.users.id, personId));
      expect(u!.forgeUserId).toBe('w20-10-fid');

      // Someone who is not a member of this workspace is a 404, bad input a 400.
      const [stranger] = await db
        .insert(core.users)
        .values({ authProvider: 'oidc', authSubject: 'w20-10-stranger', login: 'w20-10-stranger' })
        .returning();
      expect((await link(aliceEmailId, stranger!.id)).statusCode).toBe(404);
      await db.delete(core.users).where(eq(core.users.id, stranger!.id));
      expect((await link(aliceEmailId, 'bob')).statusCode).toBe(400);

      expect((await link(withForge!.id, null)).statusCode).toBe(200);
      expect(await linkedTo(withForge!.id)).toBeNull();
    } finally {
      await db.delete(core.identities).where(eq(core.identities.id, withForge!.id));
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, personId));
      await db.delete(core.users).where(eq(core.users.id, personId));
    }
  });

  it('flags a bot, and a member cannot', async () => {
    const cookie = await adminSession();
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/identities/${botId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { is_bot: true },
    });
    expect(ok.statusCode).toBe(200);
    const [row] = await db
      .select({ isBot: core.identities.isBot })
      .from(core.identities)
      .where(eq(core.identities.id, botId));
    expect(row!.isBot).toBe(true);

    const memberCookie = await loginAs(app, 'w5-05-member');
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/identities/${botId}`,
      cookies: { repopulse_sid: memberCookie },
      headers: CSRF,
      payload: { is_bot: false },
    });
    expect(denied.statusCode).toBe(403);
    // Membership first: logging in creates a workspace_members row (FR-AUTH-3),
    // and deleting the user while it exists violates the FK.
    const [m] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, 'w5-05-member'));
    if (m) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, m.id));
      await db.delete(core.users).where(eq(core.users.id, m.id));
    }
  });
});
