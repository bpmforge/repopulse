import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from '../auth/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import apiV1 from '../../plugins/api-v1.js';
import syncRoutes from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;
const MEMBER = 'w2-05-sync-member';

describeIfLiveInfra('GET /sync/status (W2-05, FR-INGEST-8)', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db: Database = createDb(databaseUrl as string);

  async function loginAs(forgeUserId: string): Promise<string> {
    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(loginRes.headers.location as string).searchParams.get('state');
    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state')!;
    const cb = await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: forgeUserId, state: state as string },
      cookies: { oauth_state: stateCookie.value },
    });
    return cb.cookies.find((c) => c.name === 'repopulse_sid')!.value;
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
        await apiV1(instance, { db, redisUrl: redisUrl as string });
        await instance.register(syncRoutes, { db });
      },
      { prefix: '/api/v1' },
    );
    await app.ready();
    await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } });
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      githubMock.close((e) => (e ? reject(e) : resolve())),
    );
    const [u] = await db.select().from(core.users).where(eq(core.users.forgeUserId, MEMBER));
    if (u) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, u.id));
      await db.delete(core.users).where(eq(core.users.id, u.id));
    }
    await db.$client.end();
  });

  it('no session → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync/status' });
    expect(res.statusCode).toBe(401);
  });

  it('returns an org sync aggregate (warehouse-only) for a member', async () => {
    const cookie = await loginAs(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('phase');
    expect(body).toHaveProperty('repoCount');
    expect(Array.isArray(body.repos)).toBe(true);
  });
});
