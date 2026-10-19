import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from '../auth/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import apiV1 from '../../plugins/api-v1.js';
import { lastWebhookByRepo } from './index.js';

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
        await apiV1(instance, {
          db,
          redisUrl: redisUrl as string,
          tokenKey: Buffer.alloc(32, 7),
          webhookUrl: 'http://localhost/api/v1/webhooks/github',
          enqueueBackfillPlan: async () => {},
        });
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

  // W20-14 (UX_TODO INS-32): the "last webhook" column's data.
  it('reports the newest webhook delivery per repo, matched on connection and full name', async () => {
    const [ws] = await db
      .select({ id: core.workspaces.id })
      .from(core.workspaces)
      .where(eq(core.workspaces.slug, 'default'));
    const workspaceId = ws!.id;
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.alloc(8),
        credentialIv: Buffer.alloc(12),
        keyVersion: 1,
        credentialFingerprint: 'w20-14-sync-fp',
        status: 'active',
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w20-14-sync-repo',
        org: 'w20-14',
        name: 'hooked',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    const newest = new Date('2026-10-01T10:00:00Z');
    await db.insert(core.webhookDelivery).values([
      {
        workspaceId,
        connectionId: conn!.id,
        deliveryId: 'w20-14-d1',
        event: 'push',
        repoFullName: 'w20-14/hooked',
        receivedAt: new Date('2026-09-30T10:00:00Z'),
        payloadDigest: 'x',
      },
      {
        workspaceId,
        connectionId: conn!.id,
        deliveryId: 'w20-14-d2',
        event: 'push',
        repoFullName: 'w20-14/hooked',
        receivedAt: newest,
        payloadDigest: 'y',
      },
      {
        workspaceId,
        connectionId: conn!.id,
        deliveryId: 'w20-14-d3',
        event: 'push',
        repoFullName: 'w20-14/other',
        receivedAt: new Date('2026-10-05T10:00:00Z'),
        payloadDigest: 'z',
      },
    ]);
    try {
      const hooks = await lastWebhookByRepo(db, workspaceId);
      expect(hooks.get(String(repo!.id))).toBe(newest.toISOString());
    } finally {
      await db.delete(core.webhookDelivery).where(eq(core.webhookDelivery.connectionId, conn!.id));
      await db.delete(core.repos).where(eq(core.repos.id, repo!.id));
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, conn!.id));
    }
  });
});
