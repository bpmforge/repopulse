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
