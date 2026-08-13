import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  core,
  createDb,
  read,
  trackRoutes,
  walkForTenancyLeakage,
  type DiscoveredRoute,
} from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from '../../src/routes/auth/index.js';
import errorEnvelopePlugin from '../../src/plugins/error-envelope.js';
import apiV1 from '../../src/plugins/api-v1.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const FORGE_USER_ID = 'w1-07-tenancy-test-user';
const OTHER_WORKSPACE_SLUG = 'w1-07-other-tenant';
const OTHER_WORKSPACE_MARKER = 'MARKER-OTHER-TENANT-W1-07';

// NFR-4/FR-AUTH-3: v1 ships a single `default` workspace (D1) - every real
// login resolves to it via ensureMembership, so there is no way today for
// two different *sessions* to land in two different real workspaces. This
// suite instead proves the walker mechanism against the real preHandler,
// real session, and real DB: a second workspace row exists as pure data
// (never resolved through any login) and its marker must never leak to the
// one real authenticated tenant, regardless of how a given route is coded.
describeIfLiveInfra('route-walker tenancy isolation (NFR-4, W1-07)', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  let getRoutes: () => DiscoveredRoute[];
  let sessionCookie: string;
  let defaultWorkspaceName: string;

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
          const auth = req.headers.authorization ?? '';
          const forgeUserId = auth.replace('Bearer ', '');
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
    await new Promise<void>((resolve) => githubMock.listen(0, resolve));
    const address = githubMock.address();
    if (address === null || typeof address === 'string') throw new Error('mock did not bind');
    const base = `http://127.0.0.1:${address.port}`;

    const [defaultWorkspace] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    if (!defaultWorkspace) throw new Error('default workspace upsert returned no row');
    defaultWorkspaceName = defaultWorkspace.name;

    await db
      .insert(core.workspaces)
      .values({ slug: OTHER_WORKSPACE_SLUG, name: OTHER_WORKSPACE_MARKER })
      .onConflictDoUpdate({
        target: core.workspaces.slug,
        set: { name: OTHER_WORKSPACE_MARKER },
      });

    app = Fastify();
    getRoutes = trackRoutes(app);
    await app.register(errorEnvelopePlugin);
    await app.register(authRoutes, {
      db,
      githubOAuth: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
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
        // apiV1 now mounts the W4-01 drill-down/personal routes (GET /repos,
        // /me/*) itself (W4-02) — the walker below proves the parameter-free
        // ones leak no other tenant's data. No manual registration here or
        // they'd double-declare.
        await apiV1(instance, { db, redisUrl: redisUrl as string });

        // Correctly scoped: reads only the requester's own workspace row.
        instance.get('/api/v1/_tenancy_test/scoped-ok', async (request) => {
          const rows = await db
            .select({ name: core.workspaces.name })
            .from(core.workspaces)
            .where(eq(core.workspaces.id, request.workspace!.id));
          return { names: rows.map((r) => r.name) };
        });

        // Deliberately unscoped: ignores request.workspace entirely. Proves
        // the walker's own failure mode (acceptance: "adding an unscoped
        // route fails the walker").
        instance.get('/api/v1/_tenancy_test/scoped-bad', async () => {
          const rows = await db.select({ name: core.workspaces.name }).from(core.workspaces);
          return { names: rows.map((r) => r.name) };
        });
      },
      { prefix: '' },
    );
    await app.ready();

    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(loginRes.headers.location as string).searchParams.get('state');
    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state')!;
    const callbackRes = await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: FORGE_USER_ID, state: state as string },
      cookies: { oauth_state: stateCookie.value },
    });
    const cookie = callbackRes.cookies.find((c) => c.name === 'repopulse_sid');
    if (!cookie) throw new Error(`login failed: ${callbackRes.body}`);
    sessionCookie = cookie.value;
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      githubMock.close((err) => (err ? reject(err) : resolve())),
    );
    const [user] = await db
      .select()
      .from(core.users)
      .where(eq(core.users.forgeUserId, FORGE_USER_ID))
      .limit(1);
    if (user) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, user.id));
      await db.delete(core.users).where(eq(core.users.id, user.id));
    }
    await db.delete(core.workspaces).where(eq(core.workspaces.slug, OTHER_WORKSPACE_SLUG));
    await db.$client.end();
  });

  it('the correctly-scoped route never leaks the other workspace marker', async () => {
    const probes = [
      { requestContext: { cookies: { repopulse_sid: sessionCookie } }, marker: '__self__' },
      { requestContext: {}, marker: OTHER_WORKSPACE_MARKER },
    ];
    const routes = getRoutes().filter((r) => r.url === '/api/v1/_tenancy_test/scoped-ok');
    const violations = await walkForTenancyLeakage(app, routes, probes);
    expect(violations).toEqual([]);

    // Sanity: the scoped route really did return the requester's own data.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/_tenancy_test/scoped-ok',
      cookies: { repopulse_sid: sessionCookie },
    });
    expect(res.json()).toEqual({ names: [defaultWorkspaceName] });
  });

  it('the deliberately-unscoped route is caught by the walker (acceptance: fails on an unscoped route)', async () => {
    const probes = [
      { requestContext: { cookies: { repopulse_sid: sessionCookie } }, marker: '__self__' },
      { requestContext: {}, marker: OTHER_WORKSPACE_MARKER },
    ];
    const routes = getRoutes().filter((r) => r.url === '/api/v1/_tenancy_test/scoped-bad');
    const violations = await walkForTenancyLeakage(app, routes, probes);
    expect(violations).toContainEqual(
      expect.objectContaining({
        url: '/api/v1/_tenancy_test/scoped-bad',
        leakedMarker: OTHER_WORKSPACE_MARKER,
      }),
    );
  });

  it('exempt routes (/auth/*, /healthz, /api/v1/openapi.json) are never walked', async () => {
    const routes = getRoutes();
    const violations = await walkForTenancyLeakage(app, routes, [
      { requestContext: { cookies: { repopulse_sid: sessionCookie } }, marker: '__self__' },
      { requestContext: {}, marker: OTHER_WORKSPACE_MARKER },
    ]);
    expect(violations.every((v) => !v.url.startsWith('/auth'))).toBe(true);
  });

  it('W4-01 parameter-free drill-down/personal routes leak no other tenant data', async () => {
    // GET /repos, /me/prs, /me/review-queue, /me/hotspots, /me/stats — an
    // unauthenticated probe 401s (apiV1 guard), so the OTHER_WORKSPACE_MARKER
    // never appears; the real session sees only its own workspace.
    // This harness registers the child at prefix '' (the synthetic routes
    // hardcode /api/v1/…), so these land at /repos and /me/* here.
    const w401 = getRoutes().filter((r) => r.url === '/repos' || r.url.startsWith('/me/'));
    expect(w401.length).toBeGreaterThan(0);
    const violations = await walkForTenancyLeakage(app, w401, [
      { requestContext: { cookies: { repopulse_sid: sessionCookie } }, marker: '__self__' },
      { requestContext: {}, marker: OTHER_WORKSPACE_MARKER },
    ]);
    expect(violations).toEqual([]);
  });

  // W5-01: GET /views (parameter-free, walkable per route-walker.ts's own
  // limitation) walked for real, with two REAL sessions rather than the
  // real-session/unauthenticated pattern above — v1's single-workspace
  // design (FOUNDING_BRIEST D1) means two real logins can't land in two
  // different *workspaces*, but they land as two different *owners* in the
  // same one, which is exactly what GET /views scopes on.
  it("GET /views never leaks another owner's view name", async () => {
    const secondForgeUserId = 'w1-07-tenancy-second-owner';
    const secondLoginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const secondState = new URL(secondLoginRes.headers.location as string).searchParams.get(
      'state',
    );
    const secondStateCookie = secondLoginRes.cookies.find((c) => c.name === 'oauth_state')!;
    const secondCallbackRes = await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: secondForgeUserId, state: secondState as string },
      cookies: { oauth_state: secondStateCookie.value },
    });
    const secondCookie = secondCallbackRes.cookies.find((c) => c.name === 'repopulse_sid');
    if (!secondCookie) throw new Error(`login failed: ${secondCallbackRes.body}`);

    const OWNER_A_MARKER = 'MARKER-VIEW-OWNER-A';
    const OWNER_B_MARKER = 'MARKER-VIEW-OWNER-B';
    const viewBody = { config: { repo_ids: [], window: '30d' as const, layout: [] } };
    await app.inject({
      method: 'POST',
      url: '/api/v1/views',
      cookies: { repopulse_sid: sessionCookie },
      payload: { name: OWNER_A_MARKER, ...viewBody },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/views',
      cookies: { repopulse_sid: secondCookie.value },
      payload: { name: OWNER_B_MARKER, ...viewBody },
    });

    const routes = getRoutes().filter((r) => r.url === '/api/v1/views');
    const violations = await walkForTenancyLeakage(app, routes, [
      { requestContext: { cookies: { repopulse_sid: sessionCookie } }, marker: OWNER_A_MARKER },
      {
        requestContext: { cookies: { repopulse_sid: secondCookie.value } },
        marker: OWNER_B_MARKER,
      },
    ]);
    expect(violations).toEqual([]);

    // Clean up both owners' views now — the outer afterAll deletes
    // FORGE_USER_ID's user row without first clearing saved_views, which
    // would otherwise hit the ownerUserId FK (no cascade).
    const [firstUser] = await db
      .select()
      .from(core.users)
      .where(eq(core.users.forgeUserId, FORGE_USER_ID))
      .limit(1);
    if (firstUser) {
      await db.delete(read.savedViews).where(eq(read.savedViews.ownerUserId, firstUser.id));
    }
    const [secondUser] = await db
      .select()
      .from(core.users)
      .where(eq(core.users.forgeUserId, secondForgeUserId))
      .limit(1);
    if (secondUser) {
      await db.delete(read.savedViews).where(eq(read.savedViews.ownerUserId, secondUser.id));
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, secondUser.id));
      await db.delete(core.users).where(eq(core.users.id, secondUser.id));
    }
  });
});
