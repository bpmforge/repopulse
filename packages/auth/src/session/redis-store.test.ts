import 'dotenv/config';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from 'fastify';
import { RedisSessionStore } from './redis-store.js';

// Live compose Redis (scripts/dev-up.sh), matching the repo's convention of
// testing real infra rather than a mock (see validate-egress-audit.sh).
const redisUrl = process.env.REDIS_URL;
const describeIfRedis = redisUrl ? describe : describe.skip;

describeIfRedis('RedisSessionStore (live Redis)', () => {
  let redis: Redis;
  let store: RedisSessionStore;
  const keyPrefix = `test:w1-03:${Date.now()}:`;

  beforeAll(() => {
    if (!redisUrl) throw new Error('unreachable: guarded by describeIfRedis');
    redis = new Redis(redisUrl);
    store = new RedisSessionStore({ redis, absoluteLifetimeMs: 1000 * 60 * 60, keyPrefix });
  });

  afterEach(async () => {
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('set() then get() round-trips the session and applies the cookie maxAge as TTL', async () => {
    const session = {
      cookie: { originalMaxAge: 5000 },
      userId: 7,
      createdAt: Date.now(),
    } as unknown as Session;

    await new Promise<void>((resolve, reject) =>
      store.set('sess-1', session, (err) => (err ? reject(err) : resolve())),
    );

    const fetched = await new Promise<Session | null | undefined>((resolve, reject) =>
      store.get('sess-1', (err, s) => (err ? reject(err) : resolve(s))),
    );
    expect(fetched).toMatchObject({ userId: 7 });

    const ttlMs = await redis.pttl(`${keyPrefix}sess-1`);
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(5000);
  });

  it('get() returns null for a session id that was never set', async () => {
    const fetched = await new Promise<Session | null | undefined>((resolve, reject) =>
      store.get('never-existed', (err, s) => (err ? reject(err) : resolve(s))),
    );
    expect(fetched).toBeNull();
  });

  it('destroy() removes the key', async () => {
    const session = { cookie: {}, userId: 1, createdAt: Date.now() } as unknown as Session;
    await new Promise<void>((resolve, reject) =>
      store.set('sess-destroy', session, (err) => (err ? reject(err) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      store.destroy('sess-destroy', (err) => (err ? reject(err) : resolve())),
    );
    const fetched = await new Promise<Session | null | undefined>((resolve, reject) =>
      store.get('sess-destroy', (err, s) => (err ? reject(err) : resolve(s))),
    );
    expect(fetched).toBeNull();
  });

  it('get() rejects a session past the absolute lifetime even though the Redis TTL is still live', async () => {
    const shortLifetimeStore = new RedisSessionStore({
      redis,
      absoluteLifetimeMs: 10,
      keyPrefix,
    });
    const session = {
      cookie: { originalMaxAge: 60_000 }, // idle TTL still far from expiring
      userId: 9,
      createdAt: Date.now() - 1000, // but login was 1s ago, past the 10ms absolute cap
    } as unknown as Session;

    await new Promise<void>((resolve, reject) =>
      shortLifetimeStore.set('sess-absolute', session, (err) => (err ? reject(err) : resolve())),
    );
    // Confirm the Redis key itself is still alive (idle TTL not the reason for rejection).
    const ttlMs = await redis.pttl(`${keyPrefix}sess-absolute`);
    expect(ttlMs).toBeGreaterThan(0);

    const fetched = await new Promise<Session | null | undefined>((resolve, reject) =>
      shortLifetimeStore.get('sess-absolute', (err, s) => (err ? reject(err) : resolve(s))),
    );
    expect(fetched).toBeNull();
  });
  // W20-10 (UX_TODO ADM-78): a per-user index, so a password change and
  // "Sign out everywhere" can end the account's other sessions.
  it('indexes sessions by owner and ends all but the kept one', async () => {
    const put = (id: string, fields: Record<string, unknown>) =>
      new Promise<void>((resolve, reject) =>
        store.set(
          id,
          {
            cookie: { originalMaxAge: 60_000 },
            createdAt: Date.now(),
            ...fields,
          } as unknown as Session,
          (err) => (err ? reject(err) : resolve()),
        ),
      );
    await put('u1-a', { userId: 41 });
    await put('u1-b', { userId: 41 });
    // A pending password change belongs to its account too.
    await put('u1-c', { pendingPasswordChangeUserId: 41 });
    await put('u2-a', { userId: 42 });
    await put('anon', {});

    expect(await store.countUserSessions(41)).toBe(3);
    expect(await store.destroyUserSessions(41, 'u1-a')).toBe(2);
    expect(await store.countUserSessions(41)).toBe(1);
    expect(await redis.exists(`${keyPrefix}u1-a`)).toBe(1);
    expect(await redis.exists(`${keyPrefix}u1-b`)).toBe(0);
    expect(await store.countUserSessions(42)).toBe(1);
    expect(await store.destroyUserSessions(41)).toBe(1);
    expect(await store.destroyUserSessions(41)).toBe(0);
  });
});
