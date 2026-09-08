import 'dotenv/config';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HEARTBEAT_PREFIX, readWorkerHeartbeats, startWorkerHeartbeat } from './heartbeat.js';

// Live compose Redis (scripts/dev-up.sh), matching the repo's convention of
// testing real infra rather than a mock — the TTL behaviour this depends on is
// precisely what a mock would get wrong.
const redisUrl = process.env.REDIS_URL;
const describeIfRedis = redisUrl ? describe : describe.skip;

describeIfRedis('worker heartbeat (W17-06)', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl as string);
  });

  afterEach(async () => {
    const keys = await redis.keys(`${HEARTBEAT_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('publishes an instance heartbeat that an outside reader can see', async () => {
    const hb = startWorkerHeartbeat({
      redis,
      queues: ['backfill', 'enrich'],
      instanceId: 'test-a',
    });
    await hb.beat();

    const live = await readWorkerHeartbeats(redis);
    expect(live.map((h) => h.instanceId)).toEqual(['test-a']);
    expect(live[0]?.queues).toEqual(['backfill', 'enrich']);
    expect(live[0]?.pid).toBe(process.pid);

    await hb.stop();
  });

  it('carries no secret and no repository content', async () => {
    const hb = startWorkerHeartbeat({ redis, queues: ['backfill'], instanceId: 'test-safe' });
    await hb.beat();

    const raw = (await redis.get(`${HEARTBEAT_PREFIX}test-safe`)) ?? '';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // An allow-list, not a deny-list: a field added later has to be considered
    // here rather than shipping to an admin page unreviewed.
    expect(Object.keys(parsed).sort()).toEqual(
      ['host', 'instanceId', 'lastBeatAt', 'pid', 'queues', 'startedAt'].sort(),
    );

    await hb.stop();
  });

  it('sets a TTL, so a SIGKILLed worker cannot look alive forever', async () => {
    const hb = startWorkerHeartbeat({
      redis,
      queues: ['backfill'],
      instanceId: 'test-ttl',
      ttlSeconds: 60,
    });
    await hb.beat();

    const ttl = await redis.ttl(`${HEARTBEAT_PREFIX}test-ttl`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    await hb.stop();
  });

  it('disappears within its TTL when the process stops beating', async () => {
    // The SIGKILL case: no clean stop, nothing deletes the key, only expiry.
    const hb = startWorkerHeartbeat({
      redis,
      queues: ['backfill'],
      instanceId: 'test-expiry',
      ttlSeconds: 1,
      intervalMs: 60_000, // never refreshes within the test
    });
    await hb.beat();
    expect(await readWorkerHeartbeats(redis)).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 1500));

    expect(await readWorkerHeartbeats(redis)).toHaveLength(0);
    await hb.stop();
  });

  it('a clean stop removes it immediately rather than waiting out the TTL', async () => {
    const hb = startWorkerHeartbeat({ redis, queues: ['backfill'], instanceId: 'test-stop' });
    await hb.beat();
    expect(await readWorkerHeartbeats(redis)).toHaveLength(1);

    await hb.stop();

    expect(await readWorkerHeartbeats(redis)).toHaveLength(0);
  });

  it('ONE worker stopping does not erase another worker heartbeat', async () => {
    // The reason the key is per-instance. A single shared key would make a
    // two-worker deployment report zero workers the moment either one stopped.
    const a = startWorkerHeartbeat({ redis, queues: ['backfill'], instanceId: 'test-a' });
    const b = startWorkerHeartbeat({ redis, queues: ['enrich'], instanceId: 'test-b' });
    await a.beat();
    await b.beat();
    expect((await readWorkerHeartbeats(redis)).map((h) => h.instanceId).sort()).toEqual([
      'test-a',
      'test-b',
    ]);

    await a.stop();

    const left = await readWorkerHeartbeats(redis);
    expect(left.map((h) => h.instanceId)).toEqual(['test-b']);
    expect(left[0]?.queues).toEqual(['enrich']);

    await b.stop();
  });

  it('refreshes the TTL on every beat', async () => {
    const hb = startWorkerHeartbeat({
      redis,
      queues: ['backfill'],
      instanceId: 'test-refresh',
      ttlSeconds: 10,
      intervalMs: 60_000,
    });
    await hb.beat();
    const first = await redis.ttl(`${HEARTBEAT_PREFIX}test-refresh`);

    await new Promise((r) => setTimeout(r, 1100));
    const decayed = await redis.ttl(`${HEARTBEAT_PREFIX}test-refresh`);
    expect(decayed).toBeLessThan(first);

    await hb.beat();
    expect(await redis.ttl(`${HEARTBEAT_PREFIX}test-refresh`)).toBeGreaterThan(decayed);

    await hb.stop();
  });

  it('a failed write is reported, never thrown into the timer', async () => {
    // A worker that cannot reach Redis has bigger problems, and its heartbeat
    // expiring is the correct signal — it must not also crash the process.
    const errors: unknown[] = [];
    const broken = {
      set: () => Promise.reject(new Error('redis gone')),
      del: () => Promise.reject(new Error('redis gone')),
    } as unknown as Redis;

    const hb = startWorkerHeartbeat({
      redis: broken,
      queues: ['backfill'],
      instanceId: 'test-broken',
      onError: (e) => errors.push(e),
    });

    await expect(hb.beat()).resolves.toBeUndefined();
    await expect(hb.stop()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});
