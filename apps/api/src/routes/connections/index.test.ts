import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import {
  ForgeHttpError,
  type ForgeProvider,
  type ForgeRepo,
  type GitHubAuth,
} from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import authRoutes from '../auth/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import apiV1 from '../../plugins/api-v1.js';
import { loginAs } from '../../testing/login.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const ADMIN = 'w2-01-conn-admin';
const MEMBER = 'w2-01-conn-member';
const TOKEN = 'ghp_routeTestSecretTokenABCDEFGH1234567890XY';

const REPOS: ForgeRepo[] = [
  {
    externalId: '201',
    name: 'alpha',
    fullName: 'acme/alpha',
    defaultBranch: 'main',
    isPrivate: true,
    isArchived: false,
    pushedAt: '2026-07-01T00:00:00Z',
    htmlUrl: '',
  },
  {
    externalId: '202',
    name: 'beta',
    fullName: 'acme/beta',
    defaultBranch: 'main',
    isPrivate: true,
    isArchived: false,
    pushedAt: null,
    htmlUrl: '',
  },
];

// Fake discovery provider — listRepos returns REPOS unless configured to throw.
let smokeBehavior: () => Promise<ForgeRepo[]> = () => Promise.resolve(REPOS);
const registerWebhook = vi.fn(
  (_ctx: unknown, _repo: string, _url: string, _secret: string, _events: string[]) =>
    Promise.resolve('hook-1'),
);
// Records every construction so tests can assert WHICH forge a stored
// connection was rebuilt against — a fake that ignores kind/baseUrl would hide
// a GitHub provider being built for a Gitea row (and its token sent to GitHub).
const providerBuilds: { kind: string | undefined; baseUrl: string | undefined }[] = [];
function fakeProvider(
  _auth: GitHubAuth,
  kind?: 'github' | 'gitea' | 'gitlab',
  baseUrl?: string,
): ForgeProvider {
  providerBuilds.push({ kind, baseUrl });
  return {
    listRepos: () => smokeBehavior().then((items) => ({ items })),
    registerWebhook,
    capabilities: { webhookScheme: kind === 'gitlab' ? 'gitlab-token' : 'hub-signature' },
  } as unknown as ForgeProvider;
}

describeIfLiveInfra('connections routes (W2-01, FR-INGEST-1, FR-AUTH-5)', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db: Database = createDb(databaseUrl as string);
  const tokenKey = randomBytes(32);
  const enqueueBackfillPlan = vi.fn(async () => {});

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
          const forgeUserId = (req.headers.authorization ?? '').replace('Bearer ', '');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ id: forgeUserId, login: forgeUserId, name: null, avatar_url: null }),
          );
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
      githubOAuth: {
        clientId: 'x',
        clientSecret: 'y',
        redirectUri: 'http://localhost:3000/auth/callback',
      },
      githubEndpoints: { tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` },
      loginRedirectUrl: 'http://localhost:5173/',
      redisUrl: redisUrl as string,
      sessionSecret: 'test-session-secret-at-least-32-characters-long',
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
          webhookUrl: 'https://repopulse.example/webhooks/github',
          enqueueBackfillPlan,
          buildProvider: fakeProvider,
        });
      },
      { prefix: '/api/v1' },
    );
    await app.ready();

    // Seed the default workspace + explicit admin/member roles.
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    for (const [forgeUserId, role] of [
      [ADMIN, 'admin'],
      [MEMBER, 'member'],
    ] as const) {
      const [u] = await db
        .insert(core.users)
        .values({
          authProvider: 'github',
          authSubject: forgeUserId,
          forgeUserId,
          login: forgeUserId,
        })
        .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: forgeUserId } })
        .returning();
      await db
        .insert(core.workspaceMembers)
        .values({ workspaceId: ws!.id, userId: u!.id, role })
        .onConflictDoUpdate({
          target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
          set: { role },
        });
    }
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      githubMock.close((e) => (e ? reject(e) : resolve())),
    );
    const [ws] = await db.select().from(core.workspaces).where(eq(core.workspaces.slug, 'default'));
    if (ws) {
      await db.delete(core.repos).where(eq(core.repos.workspaceId, ws.id));
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.workspaceId, ws.id));
    }
    for (const forgeUserId of [ADMIN, MEMBER]) {
      const [u] = await db.select().from(core.users).where(eq(core.users.forgeUserId, forgeUserId));
      if (u) {
        await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, u.id));
        await db.delete(core.users).where(eq(core.users.id, u.id));
      }
    }
    await db.$client.end();
  });

  it('a member cannot create a connection (👑 admin only → 403)', async () => {
    const cookie = await loginAs(app, MEMBER);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin creates a connection: 201, credential NOT echoed, stored encrypted', async () => {
    smokeBehavior = () => Promise.resolve(REPOS);
    const cookie = await loginAs(app, ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: 'active' });
    expect(JSON.stringify(body)).not.toContain(TOKEN); // credential never echoed

    const [conn] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, body.id));
    expect(conn!.credentialCiphertext.toString('latin1')).not.toContain(TOKEN);
  });

  it('a bad token → 400 with the bad_token kind (distinct actionable error)', async () => {
    smokeBehavior = () => Promise.reject({ status: 401 });
    const cookie = await loginAs(app, ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toContain('bad_token');
    smokeBehavior = () => Promise.resolve(REPOS);
  });

  it('selecting repos creates pending_backfill rows, registers webhooks, enqueues plans', async () => {
    const cookie = await loginAs(app, ADMIN);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN },
    });
    const connId = created.json().id as number;

    registerWebhook.mockClear();
    enqueueBackfillPlan.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_forge_ids: ['201', '202'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo_ids).toHaveLength(2);
    expect(registerWebhook).toHaveBeenCalledTimes(2);
    expect(enqueueBackfillPlan).toHaveBeenCalledTimes(2);

    const repos = await db.select().from(core.repos).where(eq(core.repos.connectionId, connId));
    expect(repos).toHaveLength(2);
    expect(repos.every((r) => r.syncStatus === 'pending_backfill')).toBe(true);
  });

  it('GET /connections lists last4 + fingerprint + repo_count, never ciphertext', async () => {
    const cookie = await loginAs(app, ADMIN);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { last4: string; fingerprint: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.last4).toBe(TOKEN.slice(-4));
    expect(JSON.stringify(items)).not.toContain(TOKEN);
  });

  // The stored-connection routes must rebuild the provider from the ROW's forge
  // W17-35: listRepos now rejects on an HTTP error instead of returning an
  // empty list. Discovery must turn that into a problem that names the forge's
  // answer, not a bare 500 — and certainly not "this token can see 0 repos".
  // GitLab subgroups (W17-36 verifier finding): `platform/tools/widget` was
  // split on EVERY slash into org `platform`, name `tools`, so the stored row
  // named a project that does not exist — its API calls and its webhook
  // lookup (full-path match) could never succeed.
  it('keeps a nested namespace intact: org is everything before the LAST slash', async () => {
    const nested: ForgeRepo = {
      ...REPOS[0]!,
      externalId: '301',
      name: 'widget',
      fullName: 'platform/tools/widget',
    };
    smokeBehavior = () => Promise.resolve([nested]);
    const cookie = await loginAs(app, ADMIN);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { provider: 'gitlab', auth_kind: 'pat', credential: TOKEN },
    });
    expect(created.statusCode).toBe(201);
    const connId = created.json().id as number;
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/connections/${connId}/available-repos`,
      cookies: { repopulse_sid: cookie },
    });
    expect(listed.json().items[0]).toMatchObject({ org: 'platform/tools', name: 'widget' });
    const selected = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_forge_ids: ['301'] },
    });
    expect(selected.statusCode).toBe(200);
    const rows = await db.select().from(core.repos).where(eq(core.repos.connectionId, connId));
    expect(rows.map((r) => `${r.org}|${r.name}`)).toEqual(['platform/tools|widget']);
    expect(registerWebhook.mock.calls.at(-1)![1]).toBe('platform/tools/widget');
    smokeBehavior = () => Promise.resolve(REPOS);
  });

  it('available-repos answers 502 naming the forge status when the forge refuses the listing', async () => {
    smokeBehavior = () => Promise.resolve(REPOS);
    const cookie = await loginAs(app, ADMIN);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { provider: 'github', auth_kind: 'pat', credential: TOKEN },
    });
    expect(created.statusCode).toBe(201);
    smokeBehavior = () =>
      Promise.reject(new ForgeHttpError(403, 'repos', 'Resource not accessible by token'));
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/connections/${created.json().id as number}/available-repos`,
      cookies: { repopulse_sid: cookie },
    });
    expect(listed.statusCode).toBe(502);
    expect(listed.json().detail).toContain('HTTP 403');
    expect(listed.json().detail).toContain('Resource not accessible by token');
  });

  // kind + base URL. Before this fix they passed neither, so a Gitea (or GHES)
  // connection was rebuilt as a github.com provider: a 500, and the self-hosted
  // token sent to api.github.com.
  for (const [provider, baseUrl] of [
    ['gitea', 'https://gitea.internal.example'],
    ['github', 'https://ghe.acme.example/api/v3'],
    ['gitlab', 'https://gitlab.internal.example'],
  ] as const) {
    it(`rebuilds a stored ${provider} connection against its own kind + base URL (${baseUrl})`, async () => {
      smokeBehavior = () => Promise.resolve(REPOS);
      const cookie = await loginAs(app, ADMIN);
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/connections',
        cookies: { repopulse_sid: cookie },
        payload: { provider, auth_kind: 'pat', credential: TOKEN, base_url: baseUrl },
      });
      expect(created.statusCode).toBe(201);
      const connId = created.json().id as number;

      providerBuilds.length = 0;
      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/connections/${connId}/available-repos`,
        cookies: { repopulse_sid: cookie },
      });
      expect(listed.statusCode).toBe(200);
      expect(providerBuilds).toEqual([{ kind: provider, baseUrl }]);

      providerBuilds.length = 0;
      const selected = await app.inject({
        method: 'POST',
        url: `/api/v1/connections/${connId}/repos`,
        cookies: { repopulse_sid: cookie },
        payload: { repo_forge_ids: ['201'] },
      });
      expect(selected.statusCode).toBe(200);
      expect(providerBuilds).toEqual([{ kind: provider, baseUrl }]);
      // W17-36: GitLab cannot be verified by the GitHub/Gitea receiver, so its
      // hook must point at the route that reads X-Gitlab-Token.
      const hookUrl = registerWebhook.mock.calls.at(-1)![2];
      expect(hookUrl).toMatch(
        provider === 'gitlab' ? /\/webhooks\/gitlab$/ : /\/webhooks\/github$/,
      );
    });
  }
});
