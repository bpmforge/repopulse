import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, type Database } from '@repopulse/shared';
import { buildApp } from '../../../app.js';
import { loginAs } from '../../../testing/login.js';
import { HEARTBEAT_PREFIX, startWorkerHeartbeat } from '../../../workers/heartbeat.js';
import type { SystemStatusResponse } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

// GET /admin/system (W17-07). The endpoint the Settings page polls to answer
// "is this install actually working?" — as opposed to /setup/status, which
// answers "has the operator finished configuring it?".
describeIfLiveInfra('GET /admin/system (W17-07)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let redis: Redis;
  let workspaceId: number;
  const created: string[] = [];

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      if (req.url?.startsWith('/login/oauth/access_token')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString() || '{}';
          const code = (JSON.parse(body) as { code?: string }).code ?? 'tok';
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

    redis = new Redis(redisUrl as string);

    app = buildApp({
      db,
      tokenKey: Buffer.alloc(32),
      webhookUrl: 'http://localhost/hook',
      redisUrl: redisUrl as string,
      sessionSecret: 'w17-07-session-secret-that-is-long-enough!!',
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

    // Membership is granted AFTER login, in session(), because the OAuth
    // callback is what creates the user row — pre-inserting one here and
    // making it a member grants the role to a DIFFERENT user id.
  });

  afterAll(async () => {
    // Only this file's own keys — see heartbeat.test.ts. Wiping every heartbeat
    // would knock out a real worker running on the same machine.
    const keys = await redis.keys(`${HEARTBEAT_PREFIX}w17-07-*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
    await app.close();
    for (const forgeUserId of created) {
      const [u] = await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.forgeUserId, forgeUserId));
      if (u) {
        await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, u.id));
        await db.delete(core.users).where(eq(core.users.id, u.id));
      }
    }
    await db.$client.end();
    githubMock.close();
  });

  /** Log in, then grant the role to the user the login actually created. */
  async function session(forgeUserId: string, role: 'admin' | 'member'): Promise<string> {
    const cookie = await loginAs(app, forgeUserId);
    const [u] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, forgeUserId));
    if (!u) throw new Error(`login did not create ${forgeUserId}`);
    if (!created.includes(forgeUserId)) created.push(forgeUserId);
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: u.id, role })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role },
      });
    return cookie;
  }

  async function getAs(
    forgeUserId: string,
    role: 'admin' | 'member' = 'admin',
  ): Promise<{ status: number; body: SystemStatusResponse }> {
    const cookie = await session(forgeUserId, role);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system',
      cookies: { repopulse_sid: cookie },
    });
    return { status: res.statusCode, body: res.json() as SystemStatusResponse };
  }

  it('an admin gets every component with a state and a human reason', async () => {
    const { status, body } = await getAs('w17-07-admin');

    expect(status).toBe(200);
    expect(new Date(body.checkedAt).toString()).not.toBe('Invalid Date');
    expect(body.components.map((c) => c.id).sort()).toEqual(
      ['cache', 'database', 'forge', 'models', 'scanners', 'worker'].sort(),
    );
    for (const c of body.components) {
      expect(c.reason.length, `${c.id} has no reason`).toBeGreaterThan(10);
      expect(['ready', 'degraded', 'unavailable', 'unknown', 'setup_needed']).toContain(c.state);
      // Never a zero date standing in for "never".
      if (c.lastSuccessAt !== null) {
        expect(new Date(c.lastSuccessAt).getFullYear()).toBeGreaterThan(2000);
      }
    }
  });

  it('reports the live database and cache as ready', async () => {
    const { body } = await getAs('w17-07-admin');
    expect(body.components.find((c) => c.id === 'database')?.state).toBe('ready');
    expect(body.components.find((c) => c.id === 'cache')?.state).toBe('ready');
  });

  it('a MEMBER is denied', async () => {
    const cookie = await session('w17-07-member', 'member');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('an anonymous request is denied', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/system' });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('an empty install reads as needing setup, NOT as broken', async () => {
    // The judgement that matters most. A fresh install has no model and,
    // usually, no scans — and it is working perfectly.
    const { body } = await getAs('w17-07-admin');
    const models = body.components.find((c) => c.id === 'models');

    // The invariant: an unconfigured OPTIONAL model is never reported as
    // broken. (`overall` may still be unavailable in this environment for an
    // honest reason — no worker is running during the test — so asserting on
    // `overall` here would be asserting the wrong thing. The ranking itself is
    // covered exhaustively by the worstState unit tests.)
    expect(models?.state).not.toBe('unavailable');
    expect(models?.state).not.toBe('degraded');
    if (models?.state === 'setup_needed') {
      expect(models.reason).toMatch(/optional/i);
    }
    // And the forge component must never call an unconnected install broken.
    expect(body.components.find((c) => c.id === 'forge')?.state).not.toBe('unavailable');
  });

  it('a dead worker is visible, and a live one flips it back', async () => {
    // With no heartbeat published, the worker component must say so rather than
    // stay silent — the defect this endpoint exists for.
    // This case NEEDS a genuinely empty heartbeat keyspace, so it is skipped
    // rather than faked when a real worker is running on this machine — a dev
    // stack or the e2e webServer legitimately publishes one, and deleting it to
    // make an assertion pass would break the thing it belongs to.
    const foreign = (await redis.keys(`${HEARTBEAT_PREFIX}*`)).filter(
      (k) => !k.includes('w17-07-'),
    );
    if (foreign.length > 0) {
      expect(foreign.length).toBeGreaterThan(0); // recorded: a real worker is up
      return;
    }
    const keys = await redis.keys(`${HEARTBEAT_PREFIX}w17-07-*`);
    if (keys.length) await redis.del(...keys);

    const dead = await getAs('w17-07-admin');
    const deadWorker = dead.body.components.find((c) => c.id === 'worker');
    expect(deadWorker?.state).toBe('unavailable');
    expect(deadWorker?.reason).toMatch(/heartbeat/i);
    expect(deadWorker?.action?.href).toBeTruthy();

    const hb = startWorkerHeartbeat({ redis, queues: ['backfill'], instanceId: 'w17-07-live' });
    await hb.beat();

    const alive = await getAs('w17-07-admin');
    const aliveWorker = alive.body.components.find((c) => c.id === 'worker');
    expect(aliveWorker?.state).toBe('ready');
    expect(aliveWorker?.lastSuccessAt).toBeTruthy();

    await hb.stop();
  });

  it('exposes no key, connection string or filesystem path', async () => {
    const { body } = await getAs('w17-07-admin');
    const text = JSON.stringify(body);

    expect(text).not.toMatch(/postgres:\/\//);
    expect(text).not.toMatch(/redis:\/\//);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toContain(process.env.DATABASE_URL ?? '@@never@@');
    expect(text).not.toContain(process.env.REDIS_URL ?? '@@never@@');
    // Absolute host paths would leak the deployment's layout.
    expect(text).not.toMatch(/\/(?:home|Users|var\/lib)\//);
  });
});
