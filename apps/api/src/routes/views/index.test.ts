import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from '../auth/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import apiV1 from '../../plugins/api-v1.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const OWNER_FORGE_USER_ID = 'w5-01-owner';
const OTHER_FORGE_USER_ID = 'w5-01-other';
const GHOST_FORGE_USER_ID = 'w5-01-ghost'; // seeded directly, never logs in

// FR-API-6/FR-WEB-5, SC-17. v1 ships a single 'default' workspace
// (FOUNDING_BRIEF D1) — every real login lands every user in the same
// workspace, so the owner/non-owner tests below use two real sessions in
// that one workspace, while the foreign-workspace (Law 5) tests seed a
// second workspace + view directly in the DB rather than through a login
// flow the app doesn't support yet.
describeIfLiveInfra('views routes (W5-01)', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db: Database = createDb(databaseUrl as string);
  let foreignViewId: number;
  let foreignShareSlug: string;

  async function loginAs(forgeUserId: string): Promise<string> {
    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(loginRes.headers.location as string).searchParams.get('state');
    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state')!;

    const callbackRes = await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: forgeUserId, state: state as string },
      cookies: { oauth_state: stateCookie.value },
    });
    const sessionCookie = callbackRes.cookies.find((c) => c.name === 'repopulse_sid');
    if (!sessionCookie) throw new Error(`login failed for ${forgeUserId}: ${callbackRes.body}`);
    return sessionCookie.value;
  }

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

    app = Fastify();
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
    await app.register(apiV1, { db, prefix: '/api/v1' });
    await app.ready();

    const [defaultWorkspace] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    if (!defaultWorkspace) throw new Error('default workspace upsert returned no row');

    const [foreignWorkspace] = await db
      .insert(core.workspaces)
      .values({ slug: 'w5-01-foreign', name: 'Foreign' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Foreign' } })
      .returning();
    if (!foreignWorkspace) throw new Error('foreign workspace upsert returned no row');

    const [ghost] = await db
      .insert(core.users)
      .values({ forgeUserId: GHOST_FORGE_USER_ID, login: GHOST_FORGE_USER_ID })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: GHOST_FORGE_USER_ID } })
      .returning();
    if (!ghost) throw new Error('ghost user upsert returned no row');

    const [foreignView] = await db
      .insert(read.savedViews)
      .values({
        workspaceId: foreignWorkspace.id,
        ownerUserId: ghost.id,
        name: 'Foreign View',
        config: { repo_ids: [], window: '30d', layout: [] },
        isShared: true,
        shareSlug: 'foreignslugforeignslugforeignsl',
      })
      .returning();
    if (!foreignView) throw new Error('foreign view insert returned no row');
    foreignViewId = foreignView.id;
    foreignShareSlug = foreignView.shareSlug as string;
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      githubMock.close((err) => (err ? reject(err) : resolve())),
    );
    await db.delete(read.savedViews).where(eq(read.savedViews.id, foreignViewId));
    for (const forgeUserId of [OWNER_FORGE_USER_ID, OTHER_FORGE_USER_ID, GHOST_FORGE_USER_ID]) {
      const [user] = await db
        .select()
        .from(core.users)
        .where(eq(core.users.forgeUserId, forgeUserId))
        .limit(1);
      if (user) {
        await db.delete(read.savedViews).where(eq(read.savedViews.ownerUserId, user.id));
        await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, user.id));
        await db.delete(core.users).where(eq(core.users.id, user.id));
      }
    }
    await db.delete(core.workspaces).where(eq(core.workspaces.slug, 'w5-01-foreign'));
    await db.$client.end();
  });

  describe('no session', () => {
    it('GET /views -> 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/views' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });
    it('POST /views -> 401', async () => {
      // Body must be schema-valid — Fastify's lifecycle runs Validation
      // before preHandler, so a malformed body would 400 before the
      // session check ever runs and this wouldn't actually prove 401.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/views',
        payload: { name: 'x', config: { repo_ids: [], window: '30d', layout: [] } },
      });
      expect(res.statusCode).toBe(401);
    });
    it('GET /views/shared/:slug -> 401 (not a public link)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/views/shared/${foreignShareSlug}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('CRUD + ownership + tenancy', () => {
    let ownerCookie: string;
    let otherCookie: string;
    let viewId: number;

    beforeAll(async () => {
      ownerCookie = await loginAs(OWNER_FORGE_USER_ID);
      otherCookie = await loginAs(OTHER_FORGE_USER_ID);
    });

    it('POST /views creates a view owned by the caller', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/views',
        cookies: { repopulse_sid: ownerCookie },
        payload: {
          name: 'My View',
          config: { repo_ids: [1, 2], window: '30d', layout: [{ type: 'kpi' }] },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        name: 'My View',
        config: { repo_ids: [1, 2], window: '30d', layout: [{ type: 'kpi' }] },
        is_shared: false,
        share_slug: null,
        is_default: false,
      });
      viewId = body.id;
    });

    it("GET /views lists only the caller's own views", async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/views',
        cookies: { repopulse_sid: ownerCookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.some((v: { id: number }) => v.id === viewId)).toBe(true);

      const otherRes = await app.inject({
        method: 'GET',
        url: '/api/v1/views',
        cookies: { repopulse_sid: otherCookie },
      });
      expect(otherRes.json().items.some((v: { id: number }) => v.id === viewId)).toBe(false);
    });

    it('non-owner PATCH -> 403', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/views/${viewId}`,
        cookies: { repopulse_sid: otherCookie },
        payload: { name: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('non-owner DELETE -> 403', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/views/${viewId}`,
        cookies: { repopulse_sid: otherCookie },
      });
      expect(res.statusCode).toBe(403);
    });

    it('owner PATCH updates name and merges config partially', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/views/${viewId}`,
        cookies: { repopulse_sid: ownerCookie },
        payload: { name: 'Renamed', config: { window: '7d' } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: 'Renamed',
        config: { repo_ids: [1, 2], window: '7d', layout: [{ type: 'kpi' }] },
      });
    });

    it('foreign-workspace row -> 404 on PATCH/DELETE/share (Law 5)', async () => {
      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/views/${foreignViewId}`,
        cookies: { repopulse_sid: ownerCookie },
        payload: { name: 'nope' },
      });
      expect(patchRes.statusCode).toBe(404);

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/views/${foreignViewId}`,
        cookies: { repopulse_sid: ownerCookie },
      });
      expect(deleteRes.statusCode).toBe(404);

      const shareRes = await app.inject({
        method: 'POST',
        url: `/api/v1/views/${foreignViewId}/share`,
        cookies: { repopulse_sid: ownerCookie },
      });
      expect(shareRes.statusCode).toBe(404);
    });

    it('foreign-workspace shared slug -> 404 even though it is a real, isShared=true slug', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/views/shared/${foreignShareSlug}`,
        cookies: { repopulse_sid: ownerCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('share, resolve as another workspace member, revoke by rotation, revoke by is_shared:false', async () => {
      const share1 = await app.inject({
        method: 'POST',
        url: `/api/v1/views/${viewId}/share`,
        cookies: { repopulse_sid: ownerCookie },
      });
      expect(share1.statusCode).toBe(200);
      const slug1 = share1.json().share_slug as string;
      expect(slug1).toMatch(/^[0-9a-f]{32}$/);

      const resolve1 = await app.inject({
        method: 'GET',
        url: `/api/v1/views/shared/${slug1}`,
        cookies: { repopulse_sid: otherCookie },
      });
      expect(resolve1.statusCode).toBe(200);
      expect(Object.keys(resolve1.json()).sort()).toEqual(['config', 'id', 'name']);

      // Re-sharing rotates the slug — the old one is dead.
      const share2 = await app.inject({
        method: 'POST',
        url: `/api/v1/views/${viewId}/share`,
        cookies: { repopulse_sid: ownerCookie },
      });
      const slug2 = share2.json().share_slug as string;
      expect(slug2).not.toBe(slug1);

      const staleResolve = await app.inject({
        method: 'GET',
        url: `/api/v1/views/shared/${slug1}`,
        cookies: { repopulse_sid: otherCookie },
      });
      expect(staleResolve.statusCode).toBe(404);

      const freshResolve = await app.inject({
        method: 'GET',
        url: `/api/v1/views/shared/${slug2}`,
        cookies: { repopulse_sid: otherCookie },
      });
      expect(freshResolve.statusCode).toBe(200);

      // Explicit unshare — the current slug stops resolving even though
      // the row itself still has it stored.
      const unshare = await app.inject({
        method: 'PATCH',
        url: `/api/v1/views/${viewId}`,
        cookies: { repopulse_sid: ownerCookie },
        payload: { is_shared: false },
      });
      expect(unshare.statusCode).toBe(200);

      const deadResolve = await app.inject({
        method: 'GET',
        url: `/api/v1/views/shared/${slug2}`,
        cookies: { repopulse_sid: otherCookie },
      });
      expect(deadResolve.statusCode).toBe(404);
    });

    it("PUT /me/default-view sets the caller's default, exclusively", async () => {
      const createSecond = await app.inject({
        method: 'POST',
        url: '/api/v1/views',
        cookies: { repopulse_sid: ownerCookie },
        payload: { name: 'Second View', config: { repo_ids: [], window: '30d', layout: [] } },
      });
      const secondId = createSecond.json().id as number;

      const setFirst = await app.inject({
        method: 'PUT',
        url: '/api/v1/me/default-view',
        cookies: { repopulse_sid: ownerCookie },
        payload: { view_id: viewId },
      });
      expect(setFirst.statusCode).toBe(204);

      const setSecond = await app.inject({
        method: 'PUT',
        url: '/api/v1/me/default-view',
        cookies: { repopulse_sid: ownerCookie },
        payload: { view_id: secondId },
      });
      expect(setSecond.statusCode).toBe(204);

      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/views',
        cookies: { repopulse_sid: ownerCookie },
      });
      const items = list.json().items as { id: number; is_default: boolean }[];
      const defaults = items.filter((v) => v.is_default);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.id).toBe(secondId);
    });

    it("cannot default another owner's view -> 403", async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/me/default-view',
        cookies: { repopulse_sid: otherCookie },
        payload: { view_id: viewId },
      });
      expect(res.statusCode).toBe(403);
    });

    it('owner DELETE removes the view', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/views/${viewId}`,
        cookies: { repopulse_sid: ownerCookie },
      });
      expect(res.statusCode).toBe(204);
    });
  });
});
