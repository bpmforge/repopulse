import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import type { ForgeProvider, ForgeRepo, ForgeTokenInfo, GitHubAuth } from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from '../auth/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import apiV1 from '../../plugins/api-v1.js';
import { loginAs } from '../../testing/login.js';
import { readMissingTokenInfo } from '../../workers/token-info.js';

// W20-25 (UX_TODO ADM-50; W20_DECISIONS_2 row 4), against real rows: a
// connection stores its token's owner and expiry at connect time, the list
// shows them with a 14-day warning state, a connect whose token read fails
// still connects, replacing the token re-reads, the nightly sweep reads a
// connection that was never read, and the inbox names an expiring token to
// admins only. The token itself is never returned.

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const CSRF = { 'x-requested-with': 'repopulse' };
const ADMIN = 'w20-25-token-admin';
const MEMBER = 'w20-25-token-member';
// Not a real token shape: never commit anything that looks like one.
const TOKEN = 'w2025-fake-credential-for-route-tests';
const DAY = 24 * 60 * 60 * 1000;

const REPOS: ForgeRepo[] = [
  {
    externalId: '2501',
    name: 'alpha',
    fullName: 'w2025/alpha',
    defaultBranch: 'main',
    isPrivate: true,
    isArchived: false,
    pushedAt: null,
    htmlUrl: '',
  },
];

/** What the fake forge says about the token being used, by credential. */
let tokenInfo: (credential: string) => Promise<ForgeTokenInfo> = () =>
  Promise.resolve({ ownerLogin: null, expiresAt: null });

function fakeProvider(auth: GitHubAuth): ForgeProvider {
  const credential = auth.kind === 'pat' ? auth.token : '';
  return {
    listRepos: () => Promise.resolve({ items: REPOS }),
    getTokenInfo: () => tokenInfo(credential),
    capabilities: { webhookScheme: 'hub-signature' },
  } as unknown as ForgeProvider;
}

describeIfLiveInfra('W20-25 forge token owner and expiry', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db: Database = createDb(databaseUrl as string);
  const tokenKey = randomBytes(32);
  const created: number[] = [];
  let ws: number;
  let adminCookie: string;
  let memberCookie: string;

  const connect = async (credential: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
      payload: { provider: 'github', auth_kind: 'pat', credential },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: number }).id;
    created.push(id);
    return id;
  };
  const listed = async (id: number) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: Record<string, unknown>[] }).items.find((r) => r['id'] === id)!;
  };

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/login/oauth/access_token') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code: string };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: body.code }));
          return;
        }
        if (req.url === '/user') {
          const login = (req.headers.authorization ?? '').replace('Bearer ', '');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: login, login, name: null, avatar_url: null }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((r) => githubMock.listen(0, r));
    const addr = githubMock.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock bind failed');
    const base = `http://127.0.0.1:${addr.port}`;

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    await app.register(authRoutes, {
      db,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: { tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` },
      loginRedirectUrl: 'http://localhost:5173/',
      redisUrl: redisUrl as string,
      sessionSecret: 'w20-25-session-secret-at-least-32-characters',
      idleTimeoutMs: 15 * 60 * 1000,
      absoluteLifetimeMs: 12 * 60 * 60 * 1000,
      cookieSecure: false,
    });
    await app.register(
      async (instance) => {
        await apiV1(instance, {
          db,
          redisUrl: redisUrl as string,
          tokenKey,
          webhookUrl: 'https://repopulse.example/api/v1/webhooks/github',
          enqueueBackfillPlan: async () => {},
          buildProvider: fakeProvider,
        });
      },
      { prefix: '/api/v1' },
    );
    await app.ready();

    const [w] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    ws = w!.id;
    for (const [login, role] of [
      [ADMIN, 'admin'],
      [MEMBER, 'member'],
    ] as const) {
      const [u] = await db
        .insert(core.users)
        .values({ authProvider: 'github', authSubject: login, forgeUserId: login, login })
        .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login } })
        .returning();
      await db
        .insert(core.workspaceMembers)
        .values({ workspaceId: ws, userId: u!.id, role })
        .onConflictDoUpdate({
          target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
          set: { role },
        });
    }
    adminCookie = await loginAs(app, ADMIN);
    memberCookie = await loginAs(app, MEMBER);
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => githubMock.close(() => resolve()));
    if (created.length > 0) {
      await db.delete(core.repos).where(inArray(core.repos.connectionId, created));
      await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.id, created));
    }
    await db.$client.end();
  });

  it('reads the owner and expiry at connect time and warns from 14 days out', async () => {
    const expires = new Date(Date.now() + 5 * DAY + 60_000);
    tokenInfo = () => Promise.resolve({ ownerLogin: 'ada', expiresAt: expires });
    const id = await connect(`${TOKEN}-a`);
    const row = await listed(id);
    expect(row).toMatchObject({
      token_owner: 'ada',
      token_expires_at: expires.toISOString(),
      token_expiry: 'expiring',
      token_days_left: 5,
    });
    expect(row['token_checked_at']).toEqual(expect.any(String));
    // Never the token, in any field.
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it('a token read that fails still connects, and the nightly sweep reads it later', async () => {
    tokenInfo = () => Promise.reject(new Error('forge said no'));
    const id = await connect(`${TOKEN}-b`);
    expect(await listed(id)).toMatchObject({
      token_owner: null,
      token_checked_at: null,
      token_expiry: 'unknown',
    });

    const far = new Date(Date.now() + 90 * DAY);
    const result = await readMissingTokenInfo(
      {
        db,
        providerFor: async (workspaceId, connectionId) =>
          workspaceId === ws && connectionId === id
            ? ({
                getTokenInfo: () => Promise.resolve({ ownerLogin: 'grace', expiresAt: far }),
              } as unknown as ForgeProvider)
            : null,
      },
      ws,
    );
    expect(result.read).toBeGreaterThanOrEqual(1);
    expect(await listed(id)).toMatchObject({ token_owner: 'grace', token_expiry: 'ok' });
  });

  it('replacing the token reads the new one and forgets the old expiry', async () => {
    tokenInfo = (credential) =>
      Promise.resolve(
        credential.endsWith('-c2')
          ? { ownerLogin: 'linus', expiresAt: null }
          : { ownerLogin: 'ada', expiresAt: new Date(Date.now() + 2 * DAY) },
      );
    const id = await connect(`${TOKEN}-c`);
    expect(await listed(id)).toMatchObject({ token_expiry: 'expiring' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/connections/${id}`,
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
      payload: { credential: `${TOKEN}-c2` },
    });
    expect(res.statusCode).toBe(200);
    expect(await listed(id)).toMatchObject({
      token_owner: 'linus',
      token_expires_at: null,
      token_expiry: 'unknown',
    });
  });

  it('the inbox names an expiring token to admins only', async () => {
    tokenInfo = () =>
      Promise.resolve({ ownerLogin: 'ada', expiresAt: new Date(Date.now() + 3 * DAY) });
    const id = await connect(`${TOKEN}-d`);
    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox',
      cookies: { repopulse_sid: adminCookie },
    });
    expect(admin.statusCode).toBe(200);
    const body = admin.json() as {
      unread: number;
      expiring_tokens: { connection_id: number; owner: string | null; days_left: number }[];
    };
    expect(body.expiring_tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connection_id: id, owner: 'ada', days_left: 2 }),
      ]),
    );
    expect(body.unread).toBeGreaterThanOrEqual(1);

    const member = await app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox',
      cookies: { repopulse_sid: memberCookie },
    });
    expect(member.statusCode).toBe(200);
    expect((member.json() as { expiring_tokens: unknown[] }).expiring_tokens).toEqual([]);

    // A removed connection is not warned about.
    await db
      .update(core.forgeConnections)
      .set({ status: 'removed' })
      .where(eq(core.forgeConnections.id, id));
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/me/inbox',
      cookies: { repopulse_sid: adminCookie },
    });
    const ids = (
      after.json() as { expiring_tokens: { connection_id: number }[] }
    ).expiring_tokens.map((t) => t.connection_id);
    expect(ids).not.toContain(id);
  });
});
