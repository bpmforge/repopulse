import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import authRoutes from '../auth/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import apiV1 from '../../plugins/api-v1.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;
const MEMBER = 'w3-12-member';

describeIfLiveInfra('metrics/org/hotspots read API (W3-12, FR-API-2, C1)', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db: Database = createDb(databaseUrl as string);
  let repoId: number;

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
        // apiV1 now mounts the read routes itself (W4-02) — no manual
        // metrics/org/hotspots registration here or they'd double-declare.
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

    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w3-12-conn-user', login: 'w3-12-conn-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w3-12-conn-user' } })
      .returning();
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId: ws!.id,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: ws!.id,
        connectionId: conn!.id,
        forgeRepoId: 'r-w312',
        org: 'acme',
        name: 'w312',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
        pushedAt: new Date(),
      })
      .returning();
    repoId = repo!.id;
    // Two org-rollup M5 snapshots ~31d apart for series + current(delta).
    await db.insert(read.metricSnapshots).values([
      {
        workspaceId: ws!.id,
        repoId: null,
        metricKey: 'M5',
        window: '30d',
        value: '0.500000',
        numerator: '5',
        denominator: '10',
        dims: {},
        computedAt: new Date('2026-06-18T00:00:00Z'),
      },
      {
        workspaceId: ws!.id,
        repoId: null,
        metricKey: 'M5',
        window: '30d',
        value: '0.800000',
        numerator: '8',
        denominator: '10',
        dims: {},
        computedAt: new Date('2026-07-19T00:00:00Z'),
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      githubMock.close((e) => (e ? reject(e) : resolve())),
    );
    const [ws] = await db.select().from(core.workspaces).where(eq(core.workspaces.slug, 'default'));
    if (ws) {
      await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, ws.id));
      await db.delete(core.repos).where(eq(core.repos.workspaceId, ws.id));
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.workspaceId, ws.id));
    }
    for (const forgeUserId of [MEMBER, 'w3-12-conn-user']) {
      const [u] = await db.select().from(core.users).where(eq(core.users.forgeUserId, forgeUserId));
      if (u) {
        await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, u.id));
        await db.delete(core.users).where(eq(core.users.id, u.id));
      }
    }
    await db.$client.end();
  });

  it('catalog serves the FR-METRICS-15 definitions (12 metrics)', async () => {
    const cookie = await loginAs(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics/catalog',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; formula: string }[];
    expect(items).toHaveLength(12);
    expect(items[0]).toHaveProperty('formula');
  });

  it('series returns the snapshot time-series oldest-first (§4 shape)', async () => {
    const cookie = await loginAs(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics/series?metric_key=M5&window=30d',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const points = res.json().points as { value: number; numerator: number }[];
    expect(points).toHaveLength(2);
    expect(points[0]!.value).toBeCloseTo(0.5, 5); // oldest first
    expect(points[1]!.value).toBeCloseTo(0.8, 5);
    expect(points[0]).toHaveProperty('numerator');
  });

  it('current returns latest + delta vs previous window', async () => {
    const cookie = await loginAs(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/metrics/current?metric_key=M5&window=30d',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ current: 0.8, previous: 0.5 });
    expect(res.json().delta).toBeCloseTo(0.3, 5);
  });

  it('org/summary + health-tiles + hotspots read the warehouse for a member', async () => {
    const cookie = await loginAs(MEMBER);
    const summary = await app.inject({
      method: 'GET',
      url: '/api/v1/org/summary',
      cookies: { repopulse_sid: cookie },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().tiles).toHaveLength(5);

    const tiles = await app.inject({
      method: 'GET',
      url: '/api/v1/org/health-tiles',
      cookies: { repopulse_sid: cookie },
    });
    expect(tiles.statusCode).toBe(200);
    expect(tiles.json().items.some((t: { id: number }) => t.id === repoId)).toBe(true);

    const hot = await app.inject({
      method: 'GET',
      url: '/api/v1/hotspots',
      cookies: { repopulse_sid: cookie },
    });
    expect(hot.statusCode).toBe(200);
    expect(Array.isArray(hot.json().items)).toBe(true);
  });

  it('NOCK GUARD: no handler makes an HTTP egress call (C1, FR-API-2)', async () => {
    const cookie = await loginAs(MEMBER);
    // Any fetch/HTTP egress from a handler would throw here → the request 500s.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden egress'));
    try {
      for (const url of [
        '/api/v1/metrics/catalog',
        '/api/v1/metrics/series?metric_key=M5&window=30d',
        '/api/v1/metrics/current?metric_key=M5&window=30d',
        '/api/v1/org/summary',
        '/api/v1/org/health-tiles',
        '/api/v1/hotspots',
      ]) {
        const res = await app.inject({ method: 'GET', url, cookies: { repopulse_sid: cookie } });
        expect(res.statusCode, url).toBe(200);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
