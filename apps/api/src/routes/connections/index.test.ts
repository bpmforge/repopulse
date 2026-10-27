import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import {
  DEFAULT_GITLAB_BASE_URL,
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
// W20-07 (INS-52): when set, listRepos pages by cursor instead.
let pageBehavior:
  ((cursor?: string) => Promise<{ items: ForgeRepo[]; nextCursor?: string }>) | null = null;
const registerWebhook = vi.fn(
  (_ctx: unknown, _repo: string, _url: string, _secret: string, _events: string[]) =>
    Promise.resolve('hook-1'),
);
// Records every construction so tests can assert WHICH forge a stored
// connection was rebuilt against — a fake that ignores kind/baseUrl would hide
// a GitHub provider being built for a Gitea row (and its token sent to GitHub).
// W20-17: DELETE /connections removes the hooks it registered.
const deleteWebhooks = vi.fn((_ctx: unknown, _repo: string, _url: string) => Promise.resolve(1));
const providerBuilds: { kind: string | undefined; baseUrl: string | undefined }[] = [];
function fakeProvider(
  _auth: GitHubAuth,
  kind?: 'github' | 'gitea' | 'gitlab',
  baseUrl?: string,
): ForgeProvider {
  providerBuilds.push({ kind, baseUrl });
  return {
    listRepos: (_ctx: unknown, cursor?: string) =>
      pageBehavior ? pageBehavior(cursor) : smokeBehavior().then((items) => ({ items })),
    registerWebhook,
    deleteWebhooks,
    // A public repository the token can read but does not list as its own.
    getRepo: (_ctx: unknown, fullName: string) =>
      fullName === 'oss/outline'
        ? Promise.resolve({
            externalId: '777',
            name: 'outline',
            fullName: 'oss/outline',
            defaultBranch: 'main',
            isPrivate: false,
            isArchived: false,
            pushedAt: '2026-10-01T00:00:00Z',
            htmlUrl: '',
          } satisfies ForgeRepo)
        : Promise.reject(new ForgeHttpError(404, 'repo', 'Not Found')),
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
          forgeBaseUrl: 'https://ghe.acme.example/api/v3',
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
    // Only what THIS suite made. Other suites share the 'default' workspace
    // and run concurrently; deleting every repo in it raced their teardown
    // (a metric_snapshots FK on another suite's repo failed this afterAll).
    const [admin] = await db.select().from(core.users).where(eq(core.users.forgeUserId, ADMIN));
    if (admin) {
      const mine = await db
        .select({ id: core.forgeConnections.id })
        .from(core.forgeConnections)
        .where(eq(core.forgeConnections.createdBy, admin.id));
      const ids = mine.map((c) => c.id);
      if (ids.length > 0) {
        await db.delete(core.repos).where(inArray(core.repos.connectionId, ids));
        await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.id, ids));
      }
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
    expect(res.json().webhook_failed).toEqual([]);
  });

  // 2026-10-27 walkthrough: try RepoPulse on a public project first.
  it('tracks a public repository by owner/name that the token does not list', async () => {
    const cookie = await loginAs(app, ADMIN);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN },
    });
    const connId = created.json().id as number;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_full_names: ['oss/outline'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo_ids).toHaveLength(1);
    const repos = await db.select().from(core.repos).where(eq(core.repos.connectionId, connId));
    expect(repos.map((r) => `${r.org}/${r.name}`)).toEqual(['oss/outline']);
    expect(repos[0]!.syncStatus).toBe('pending_backfill');
  });

  it('says plainly when a named repository cannot be read', async () => {
    const cookie = await loginAs(app, ADMIN);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN },
    });
    const connId = created.json().id as number;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_full_names: ['nobody/missing'] },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.json())).toMatch(/nobody\/missing/);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_full_names: ['not a repo'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  // INS-29: a refused webhook is named in the response, not only on the row.
  it('names the repos whose webhook the forge refused', async () => {
    const cookie = await loginAs(app, ADMIN);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN },
    });
    const connId = created.json().id as number;
    registerWebhook.mockImplementationOnce(() => Promise.reject(new Error('HTTP 403')));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_forge_ids: ['201', '202'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repo_ids).toHaveLength(2);
    expect(res.json().webhook_failed).toHaveLength(1);
    expect(res.json().webhook_failed[0]).toMatch(/^acme\//);
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
    // Found by fingerprint, not items[0]: other suites add connections to the
    // shared 'default' workspace while this one runs.
    const mine = items.find((c) => c.fingerprint === credentials.credentialFingerprint(TOKEN));
    expect(mine?.last4).toBe(TOKEN.slice(-4));
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
  // ---- W20-07 -------------------------------------------------------------

  async function newConnection(cookie: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as number;
  }

  // UX_TODO INS-73: a blank GitLab URL is gitlab.com, stored on the row, and
  // never FORGE_BASE_URL (set to a GHES host for this suite).
  it('stores gitlab.com for a GitLab connection saved with no URL', async () => {
    smokeBehavior = () => Promise.resolve(REPOS);
    const cookie = await loginAs(app, ADMIN);
    providerBuilds.length = 0;
    const connId = await newConnection(cookie, { provider: 'gitlab' });
    expect(providerBuilds).toEqual([{ kind: 'gitlab', baseUrl: DEFAULT_GITLAB_BASE_URL }]);
    const [row] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, connId));
    expect(row!.baseUrl).toBe(DEFAULT_GITLAB_BASE_URL);
  });

  // UX_TODO INS-64: a TLS failure is not a bad token.
  it('reports an untrusted CA as tls_untrusted, naming the host', async () => {
    smokeBehavior = () =>
      Promise.reject(
        Object.assign(new Error('unable to get local issuer certificate'), {
          status: 500,
          request: {},
          cause: {
            code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
            message: 'unable to get local issuer certificate',
          },
        }),
      );
    const cookie = await loginAs(app, ADMIN);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: {
        provider: 'gitea',
        auth_kind: 'pat',
        credential: TOKEN,
        base_url: 'https://git.internal.example',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toContain('tls_untrusted');
    expect(res.json().detail).toContain('git.internal.example');
    smokeBehavior = () => Promise.resolve(REPOS);
  });

  // 2026-10-27 walkthrough: the worker refuses a non-https base URL on every
  // sync call, so connect must refuse it too instead of listing the repos.
  for (const baseUrl of ['http://gitea:3000', 'https://10.0.0.5', 'https://localhost:3000']) {
    it(`refuses ${baseUrl} before calling the forge, saying what is accepted`, async () => {
      const cookie = await loginAs(app, ADMIN);
      providerBuilds.length = 0;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/connections',
        cookies: { repopulse_sid: cookie },
        payload: { provider: 'gitea', auth_kind: 'pat', credential: TOKEN, base_url: baseUrl },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().title).toBe('RepoPulse cannot connect to this address');
      expect(res.json().detail).toContain('only connects to a forge over https');
      expect(providerBuilds).toEqual([]);
    });
  }

  // UX_TODO INS-52 + INS-10: every page, with the tracked ones marked.
  it('available-repos pages through every repo and marks the tracked ones', async () => {
    const cookie = await loginAs(app, ADMIN);
    const connId = await newConnection(cookie);
    await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_forge_ids: ['201'] },
    });
    const quiet: ForgeRepo = {
      ...REPOS[1]!,
      externalId: '299',
      name: 'quiet',
      fullName: 'acme/quiet',
    };
    pageBehavior = (cursor) =>
      Promise.resolve(cursor === 'p2' ? { items: [quiet] } : { items: REPOS, nextCursor: 'p2' });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/connections/${connId}/available-repos`,
        cookies: { repopulse_sid: cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: { forge_repo_id: string; tracked: boolean; sync_status: string | null }[];
        total: number;
        truncated: boolean;
      };
      expect(body.total).toBe(3);
      expect(body.truncated).toBe(false);
      expect(body.items.map((i) => [i.forge_repo_id, i.tracked, i.sync_status])).toEqual([
        ['201', true, 'pending_backfill'],
        ['202', false, null],
        ['299', false, null],
      ]);

      // ...and the repo on page two can actually be tracked.
      const tracked = await app.inject({
        method: 'POST',
        url: `/api/v1/connections/${connId}/repos`,
        cookies: { repopulse_sid: cookie },
        payload: { repo_forge_ids: ['299'] },
      });
      expect(tracked.json().repo_ids).toHaveLength(1);
    } finally {
      pageBehavior = null;
    }
  });

  // UX_TODO INS-72: the second batch signs with the SAME secret as the first,
  // and that secret is the one stored for the receiver.
  it('a second "Track" batch keeps the first batch\'s webhook secret', async () => {
    const cookie = await loginAs(app, ADMIN);
    const connId = await newConnection(cookie);
    registerWebhook.mockClear();
    for (const id of ['201', '202']) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/connections/${connId}/repos`,
        cookies: { repopulse_sid: cookie },
        payload: { repo_forge_ids: [id] },
      });
    }
    const secrets = registerWebhook.mock.calls.map((c) => c[3]);
    expect(secrets).toHaveLength(2);
    expect(secrets[0]).toBe(secrets[1]);
    const [row] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, connId));
    expect(credentials.openSecret(row!.webhookSecretCiphertext!, tokenKey)).toBe(secrets[0]);
  });

  // UX_TODO INS-08: re-key in place.
  it('PATCH refuses to re-key a connection saved with an http address before the check', async () => {
    const cookie = await loginAs(app, ADMIN);
    const connId = await newConnection(cookie, { provider: 'gitea', base_url: 'https://gitea.internal.example' });
    await db
      .update(core.forgeConnections)
      .set({ baseUrl: 'http://gitea:3000' })
      .where(eq(core.forgeConnections.id, connId));
    providerBuilds.length = 0;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/connections/${connId}`,
      cookies: { repopulse_sid: cookie },
      payload: { credential: ['ghp', 'rekeyHttpRow', 'WXYZ'].join('_') },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain('enter its https address when you replace the token');
    expect(providerBuilds).toEqual([]);
  });

  it('PATCH with base_url corrects the address in place, checked like a new one', async () => {
    const cookie = await loginAs(app, ADMIN);
    const connId = await newConnection(cookie, { provider: 'gitea', base_url: 'https://gitea.internal.example' });
    await db
      .update(core.forgeConnections)
      .set({ baseUrl: 'http://gitea:3000' })
      .where(eq(core.forgeConnections.id, connId));
    const patch = (base_url: string) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/connections/${connId}`,
        cookies: { repopulse_sid: cookie },
        payload: { credential: ['ghp', 'rekeyNewAddress', 'WXYZ'].join('_'), base_url },
      });

    const refused = await patch('http://gitea.internal.example');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().title).toBe('RepoPulse cannot connect to this address');

    providerBuilds.length = 0;
    const ok = await patch('https://gitea:3000');
    expect(ok.statusCode).toBe(200);
    expect(providerBuilds).toEqual([{ kind: 'gitea', baseUrl: 'https://gitea:3000' }]);
    const [row] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, connId));
    expect(row!.baseUrl).toBe('https://gitea:3000');
  });

  it('PATCH replaces the credential in place; a bad one leaves the old token working', async () => {
    const cookie = await loginAs(app, ADMIN);
    const connId = await newConnection(cookie);
    const rotated = ['ghp', 'rotatedRouteToken', 'QRST'].join('_');

    smokeBehavior = () => Promise.reject({ status: 401 });
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/connections/${connId}`,
      cookies: { repopulse_sid: cookie },
      payload: { credential: rotated },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().title).toContain('bad_token');
    smokeBehavior = () => Promise.resolve(REPOS);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/connections/${connId}`,
      cookies: { repopulse_sid: cookie },
      payload: { credential: rotated },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.stringify(ok.json())).not.toContain(rotated);
    const [row] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, connId));
    expect(
      credentials.decryptCredential(
        {
          ciphertext: row!.credentialCiphertext,
          iv: row!.credentialIv,
          keyVersion: row!.keyVersion,
        },
        tokenKey,
      ),
    ).toBe(rotated);
  });

  it('a member cannot re-key, remove or pause (admin only → 403)', async () => {
    const admin = await loginAs(app, ADMIN);
    const connId = await newConnection(admin);
    const member = await loginAs(app, MEMBER);
    for (const [method, url, payload] of [
      ['PATCH', `/api/v1/connections/${connId}`, { credential: TOKEN }],
      ['DELETE', `/api/v1/connections/${connId}`, undefined],
      ['PUT', `/api/v1/repos/1/tracking`, { paused: true }],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        cookies: { repopulse_sid: member },
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  // UX_TODO INS-08: removal says what happens to the tracked repos.
  it('DELETE disconnects a connection with repos (paused, history kept) and deletes an empty one', async () => {
    const cookie = await loginAs(app, ADMIN);
    const withRepos = await newConnection(cookie);
    await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${withRepos}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_forge_ids: ['201', '202'] },
    });
    deleteWebhooks.mockClear();
    // One hook removal fails: reported, not fatal.
    deleteWebhooks.mockImplementationOnce(() => Promise.reject(new Error('HTTP 404')));
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/connections/${withRepos}`,
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: withRepos,
      outcome: 'disconnected',
      paused_repos: 2,
      webhooks_removed: 1,
    });
    expect(body.webhook_failures).toHaveLength(1);
    expect(body.webhook_failures[0].error).toContain('HTTP 404');
    // W20-17: the hooks are deleted at the URL they were registered at.
    expect(deleteWebhooks).toHaveBeenCalledTimes(2);
    expect(deleteWebhooks.mock.calls[0]![2]).toMatch(/\/webhooks\//);
    const [row] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.id, withRepos));
    expect(row!.status).toBe('removed');
    expect(row!.webhookSecretCiphertext).toBeNull();
    expect(row!.credentialCiphertext.length).toBe(0);
    const repos = await db.select().from(core.repos).where(eq(core.repos.connectionId, withRepos));
    expect(repos.map((r) => r.syncStatus)).toEqual(['paused', 'paused']);
    const listing = await app.inject({
      method: 'GET',
      url: `/api/v1/connections/${withRepos}/available-repos`,
      cookies: { repopulse_sid: cookie },
    });
    expect(listing.statusCode).toBe(409);

    const empty = await newConnection(cookie);
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/v1/connections/${empty}`,
      cookies: { repopulse_sid: cookie },
    });
    expect(gone.json()).toEqual({
      id: empty,
      outcome: 'deleted',
      paused_repos: 0,
      webhooks_removed: 0,
      webhook_failures: [],
    });
    expect(
      await db.select().from(core.forgeConnections).where(eq(core.forgeConnections.id, empty)),
    ).toHaveLength(0);
  });

  // UX_TODO INS-09.
  // W20-17 (UX_TODO INS-09): "Track all and auto-add new" is remembered per
  // connection, shown on the list, and can be turned off.
  it('remembers auto-add for track-all, lists it and turns it off', async () => {
    const cookie = await loginAs(app, ADMIN);
    const connId = await newConnection(cookie);
    const sel = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { all_with_auto_add: true },
    });
    expect(sel.statusCode).toBe(200);
    const autoAddOf = async () => {
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/connections',
        cookies: { repopulse_sid: cookie },
      });
      return (list.json().items as { id: number; auto_add: boolean }[]).find((c) => c.id === connId)
        ?.auto_add;
    };
    expect(await autoAddOf()).toBe(true);
    const off = await app.inject({
      method: 'PUT',
      url: `/api/v1/connections/${connId}/auto-add`,
      cookies: { repopulse_sid: cookie },
      payload: { enabled: false },
    });
    expect(off.json()).toEqual({ id: connId, auto_add: false });
    expect(await autoAddOf()).toBe(false);

    const member = await loginAs(app, MEMBER);
    const refused = await app.inject({
      method: 'PUT',
      url: `/api/v1/connections/${connId}/auto-add`,
      cookies: { repopulse_sid: member },
      payload: { enabled: true },
    });
    expect(refused.statusCode).toBe(403);
  });

  it('pauses a repo and resumes it with a fresh backfill plan', async () => {
    const cookie = await loginAs(app, ADMIN);
    const connId = await newConnection(cookie);
    const sel = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_forge_ids: ['201'] },
    });
    const repoId = (sel.json().repo_ids as number[])[0]!;

    const paused = await app.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoId}/tracking`,
      cookies: { repopulse_sid: cookie },
      payload: { paused: true },
    });
    expect(paused.json()).toEqual({ repo_id: repoId, sync_status: 'paused' });

    enqueueBackfillPlan.mockClear();
    const resumed = await app.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoId}/tracking`,
      cookies: { repopulse_sid: cookie },
      payload: { paused: false },
    });
    expect(resumed.json()).toEqual({ repo_id: repoId, sync_status: 'pending_backfill' });
    expect(enqueueBackfillPlan).toHaveBeenCalledTimes(1);

    // W20-14 (INS-30): an errored repo is retried the same way.
    await db.update(core.repos).set({ syncStatus: 'error' }).where(eq(core.repos.id, repoId));
    enqueueBackfillPlan.mockClear();
    const retried = await app.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoId}/tracking`,
      cookies: { repopulse_sid: cookie },
      payload: { paused: false },
    });
    expect(retried.json()).toEqual({ repo_id: repoId, sync_status: 'pending_backfill' });
    expect(enqueueBackfillPlan).toHaveBeenCalledTimes(1);

    // A live repo is left alone.
    await db.update(core.repos).set({ syncStatus: 'live' }).where(eq(core.repos.id, repoId));
    enqueueBackfillPlan.mockClear();
    const live = await app.inject({
      method: 'PUT',
      url: `/api/v1/repos/${repoId}/tracking`,
      cookies: { repopulse_sid: cookie },
      payload: { paused: false },
    });
    expect(live.json()).toEqual({ repo_id: repoId, sync_status: 'live' });
    expect(enqueueBackfillPlan).not.toHaveBeenCalled();

    const missing = await app.inject({
      method: 'PUT',
      url: `/api/v1/repos/999999999/tracking`,
      cookies: { repopulse_sid: cookie },
      payload: { paused: true },
    });
    expect(missing.statusCode).toBe(404);
  });
  // W20-10 (UX_TODO ADM-77): after the install moves, every tracked repo's hook
  // still points at the old address. This re-registers them at today's URL.
  it('re-registers webhooks for tracked, unpaused repos; a member cannot', async () => {
    const cookie = await loginAs(app, ADMIN);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: cookie },
      payload: { auth_kind: 'pat', credential: TOKEN },
    });
    const connId = created.json().id as number;

    // No repo tracked yet = no webhook secret to sign with.
    const early = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/webhooks`,
      cookies: { repopulse_sid: cookie },
    });
    expect(early.statusCode).toBe(409);

    const sel = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: cookie },
      payload: { repo_forge_ids: ['201', '202'] },
    });
    const [alphaId, betaId] = sel.json().repo_ids as number[];
    await app.inject({
      method: 'PUT',
      url: `/api/v1/repos/${betaId}/tracking`,
      cookies: { repopulse_sid: cookie },
      payload: { paused: true },
    });
    await db
      .update(core.repos)
      .set({ lastError: 'live updates unavailable: hook refused' })
      .where(eq(core.repos.id, alphaId!));

    registerWebhook.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/webhooks`,
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ repos: 1, registered: 1, failed: [] });
    expect(registerWebhook).toHaveBeenCalledTimes(1);
    expect(registerWebhook.mock.calls[0]![1]).toBe('acme/alpha');
    expect(registerWebhook.mock.calls[0]![2]).toContain('https://repopulse.example/webhooks');
    const [alpha] = await db.select().from(core.repos).where(eq(core.repos.id, alphaId!));
    expect(alpha!.lastError).toBeNull();

    // A forge refusal is reported per repository, not as a 500.
    registerWebhook.mockRejectedValueOnce(new Error('Hook already exists on this repository'));
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/webhooks`,
      cookies: { repopulse_sid: cookie },
    });
    expect(again.json().failed).toEqual([
      expect.objectContaining({ repo: 'acme/alpha', error: expect.stringContaining('already') }),
    ]);

    const member = await loginAs(app, MEMBER);
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/webhooks`,
      cookies: { repopulse_sid: member },
    });
    expect(denied.statusCode).toBe(403);
  });
});
