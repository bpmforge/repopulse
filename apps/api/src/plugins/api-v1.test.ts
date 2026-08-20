import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from '../routes/auth/index.js';
import errorEnvelopePlugin from './error-envelope.js';
import apiV1 from './api-v1.js';
import { requireAdmin } from '../lib/rbac.js';
import { loginAs } from '../testing/login.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const ADMIN_FORGE_USER_ID = 'w1-04-rbac-admin';
const MEMBER_FORGE_USER_ID = 'w1-04-rbac-member';

// Proves the requireAdmin gate + request.workspace/role attachment
// (FR-AUTH-3/4) against a synthetic route, per the ticket's own guidance:
// no real admin (👑) feature routes exist yet — those are later-wave
// tickets — so there is nothing real to route-walk. Registering a
// placeholder admin route in app.ts itself would misrepresent what's
// actually built; this proves the reusable primitive instead.
describeIfLiveInfra('api-v1 guard: session -> workspace -> role (W1-04)', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);


  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/login/oauth/access_token') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code: string };
          // access_token carries the mock identity selector through to /user.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: body.code }));
          return;
        }
        if (req.url === '/user') {
          const auth = req.headers.authorization ?? '';
          const forgeUserId = auth.replace('Bearer ', '');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: forgeUserId, // fetchGithubIdentity stringifies via String(), so a string id round-trips fine
              login: forgeUserId,
              name: null,
              avatar_url: null,
            }),
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
      githubEndpoints: {
        tokenUrl: `${base}/login/oauth/access_token`,
        userUrl: `${base}/user`,
      },
      loginRedirectUrl: 'http://localhost:5173/',
      redisUrl: redisUrl as string,
      sessionSecret: 'test-session-secret-at-least-32-characters-long',
      idleTimeoutMs: 15 * 60 * 1000,
      absoluteLifetimeMs: 12 * 60 * 60 * 1000,
      cookieSecure: false,
    });
    // Test-local composition: apiV1's guard logic + a synthetic admin route
    // in the same encapsulated scope, exactly how a real feature-route
    // ticket is meant to extend it (see api-v1.ts's HANDOFF comment).
    await app.register(
      async (instance) => {
        await apiV1(instance, {
          db,
          redisUrl: redisUrl as string,
          tokenKey: Buffer.alloc(32, 7),
          webhookUrl: 'http://localhost/api/v1/webhooks/github',
          enqueueBackfillPlan: async () => {},
        });
        instance.get('/api/v1/_test/whoami', async (request) => ({
          workspace: request.workspace,
          role: request.role,
        }));
        instance.get('/api/v1/_test/admin-only', { preHandler: requireAdmin }, async () => ({
          ok: true,
        }));
      },
      { prefix: '' },
    );
    await app.ready();

    // Seed explicit roles directly rather than relying on ensureMembership's
    // first-login-becomes-admin ordering (default-workspace.test.ts already
    // covers that behavior in isolation; racing two files over "who's
    // first" on the same shared default workspace would be flaky).
    const [workspace] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    if (!workspace) throw new Error('default workspace upsert returned no row');

    for (const forgeUserId of [ADMIN_FORGE_USER_ID, MEMBER_FORGE_USER_ID]) {
      const [user] = await db
        .insert(core.users)
        .values({ authProvider: 'github', authSubject: forgeUserId, forgeUserId, login: forgeUserId })
        .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: forgeUserId } })
        .returning();
      if (!user) throw new Error(`user upsert returned no row for ${forgeUserId}`);
      await db
        .insert(core.workspaceMembers)
        .values({
          workspaceId: workspace.id,
          userId: user.id,
          role: forgeUserId === ADMIN_FORGE_USER_ID ? 'admin' : 'member',
        })
        .onConflictDoUpdate({
          target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
          set: { role: forgeUserId === ADMIN_FORGE_USER_ID ? 'admin' : 'member' },
        });
    }
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      githubMock.close((err) => (err ? reject(err) : resolve())),
    );
    for (const forgeUserId of [ADMIN_FORGE_USER_ID, MEMBER_FORGE_USER_ID]) {
      const [user] = await db
        .select()
        .from(core.users)
        .where(eq(core.users.forgeUserId, forgeUserId))
        .limit(1);
      if (user) {
        await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, user.id));
        await db.delete(core.users).where(eq(core.users.id, user.id));
      }
    }
    await db.$client.end();
  });

  it('no session -> 401 problem+json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/_test/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('resolves workspace + role onto the request for a member', async () => {
    const cookie = await loginAs(app, MEMBER_FORGE_USER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/whoami',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workspace: { slug: 'default' }, role: 'member' });
  });

  it('resolves workspace + role onto the request for an admin', async () => {
    const cookie = await loginAs(app, ADMIN_FORGE_USER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/whoami',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ workspace: { slug: 'default' }, role: 'admin' });
  });

  it('member calling an admin route -> 403 problem+json', async () => {
    const cookie = await loginAs(app, MEMBER_FORGE_USER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/admin-only',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('admin calling an admin route -> 200', async () => {
    const cookie = await loginAs(app, ADMIN_FORGE_USER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/_test/admin-only',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
