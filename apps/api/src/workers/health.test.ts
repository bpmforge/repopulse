import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { Database } from '@repopulse/shared';
import { checkWorkerHealth } from './health.js';

// Minimal stubs — checkWorkerHealth only calls db.execute() and redis.ping().
function stubDb(ok: boolean): Database {
  return {
    execute: () => (ok ? Promise.resolve([]) : Promise.reject(new Error('pg down'))),
  } as unknown as Database;
}
function stubRedis(ok: boolean): Redis {
  return {
    ping: () => (ok ? Promise.resolve('PONG') : Promise.reject(new Error('redis down'))),
  } as unknown as Redis;
}

describe('checkWorkerHealth (DEPLOYMENT §7, NFR-12)', () => {
  it('ok when both Postgres and Redis respond', async () => {
    expect(await checkWorkerHealth(stubDb(true), stubRedis(true))).toEqual({
      postgres: true,
      redis: true,
      ok: true,
    });
  });

  it('not ok if Postgres is down', async () => {
    const h = await checkWorkerHealth(stubDb(false), stubRedis(true));
    expect(h).toMatchObject({ postgres: false, redis: true, ok: false });
  });

  it('not ok if Redis is down', async () => {
    const h = await checkWorkerHealth(stubDb(true), stubRedis(false));
    expect(h).toMatchObject({ postgres: true, redis: false, ok: false });
  });
});

// --- W17-06: probes must be BOUNDED -----------------------------------------
//
// The case that matters is not a refused connection (which rejects at once) but
// a HUNG one: a dropped NAT entry, a paused VM, a server that accepted the
// socket and stopped reading. Without a deadline `select 1` never settles,
// /healthz never responds, and the container healthcheck reports a timeout
// while the process holds the socket open.

/** A dependency that accepts the call and then never answers. */
function stubHung(): { db: Database; redis: Redis } {
  const never = (): Promise<never> => new Promise<never>(() => {});
  return {
    db: { execute: never } as unknown as Database,
    redis: { ping: never } as unknown as Redis,
  };
}

describe('checkWorkerHealth deadlines (W17-06)', () => {
  it('resolves unhealthy instead of hanging when Postgres never answers', async () => {
    const hung = stubHung();
    const started = Date.now();
    const h = await checkWorkerHealth(
      hung.db,
      { ping: () => Promise.resolve('PONG') } as unknown as Redis,
      150,
    );

    expect(h).toMatchObject({ postgres: false, redis: true, ok: false });
    // It returned because of the deadline, not because it waited out a timeout
    // an order of magnitude larger.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('resolves unhealthy instead of hanging when Redis never answers', async () => {
    const hung = stubHung();
    const h = await checkWorkerHealth(
      { execute: () => Promise.resolve([]) } as unknown as Database,
      hung.redis,
      150,
    );

    expect(h).toMatchObject({ postgres: true, redis: false, ok: false });
  });

  it('both hung still resolves', async () => {
    const hung = stubHung();
    await expect(checkWorkerHealth(hung.db, hung.redis, 150)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('a healthy pair is not delayed by the deadline', async () => {
    const started = Date.now();
    const h = await checkWorkerHealth(stubDb(true), stubRedis(true), 5000);

    expect(h.ok).toBe(true);
    // If the deadline timer were awaited rather than raced, this would take 5s.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('says nothing about whether a model is configured', async () => {
    // Tier-1 ingestion needs no LLM, so an install with no analysis provider is
    // a WORKING install. Folding that into liveness would restart a good worker.
    const h = await checkWorkerHealth(stubDb(true), stubRedis(true));
    expect(Object.keys(h).sort()).toEqual(['ok', 'postgres', 'redis']);
  });
});
