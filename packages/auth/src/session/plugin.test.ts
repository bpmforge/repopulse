import 'dotenv/config';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sessionPlugin from './plugin.js';

// Live compose Redis (scripts/dev-up.sh), matching redis-store.test.ts.
const redisUrl = process.env.REDIS_URL;
const describeIfRedis = redisUrl ? describe : describe.skip;

/**
 * W17-03. Losing the Redis socket must not produce an UNHANDLED error event.
 *
 * This is the teardown path W16-34 kept seeing as `[ioredis] Unhandled error
 * event: Error: write EPIPE`. Measured 2026-09-08: three clean full runs emitted
 * it ZERO times, while two runs with a dev stack competing for the same data
 * tier emitted it 5 and 6 times. So it is contention timing, not memory, and it
 * lands in the tests that build and close an app.
 *
 * `packages/auth/src/session/plugin.ts` held the one Redis client in the
 * codebase with NO `error` listener — which is precisely what makes ioredis
 * classify the event as unhandled and print it via `console.error`
 * (ioredis/built/Redis.js:553). `routes/health/index.ts` and
 * `routes/events/index.ts` had both already guarded their own shutdown.
 *
 * Deliberately NOT a retry and NOT a raised timeout, the two fixes W16-34
 * forbids. The connection is already gone; there is nothing to retry. The error
 * is not swallowed either — it is routed to the app logger, so a real
 * connection fault is still visible in production, just no longer unhandled.
 */
describeIfRedis('session plugin shutdown (W17-03)', () => {
  const baseOpts = {
    redisUrl: redisUrl as string,
    sessionSecret: 'test-session-secret-at-least-32-characters-long',
    idleTimeoutMs: 15 * 60 * 1000,
    absoluteLifetimeMs: 12 * 60 * 60 * 1000,
    cookieSecure: false,
  };

  // ioredis prints the symptom ITSELF, via console.error, whenever its client
  // emits `error` with no registered listener (ioredis/built/Redis.js:553).
  // Spying for the whole file rather than one test matters: the event surfaces
  // in whichever test severs the socket FIRST, so a single-test spy silently
  // misses it depending on ordering.
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Give a dropped socket a tick to surface anything still in flight.
    await new Promise((r) => setTimeout(r, 100));
    const unhandled = errorSpy.mock.calls.filter((args) =>
      String(args[0]).includes('[ioredis] Unhandled error event'),
    );
    const rendered = unhandled.map((args) => String(args[1] ?? '').split('\n')[0]);
    vi.restoreAllMocks();
    expect(rendered).toEqual([]);
  });

  /** Sever every normal client from the server side — a real transport loss. */
  async function severSockets(): Promise<void> {
    const killer = new Redis(redisUrl as string);
    await killer.call('CLIENT', 'KILL', 'TYPE', 'normal').catch(() => {});
    await killer.quit().catch(() => {});
  }

  it('closes cleanly when the Redis connection is still healthy', async () => {
    const app = Fastify();
    await app.register(sessionPlugin, baseOpts);
    await app.ready();

    await expect(app.close()).resolves.toBeUndefined();
  });

  it('closes rather than rejecting when the Redis socket died first', async () => {
    const app = Fastify();
    await app.register(sessionPlugin, baseOpts);
    await app.ready();

    await severSockets();

    await expect(app.close()).resolves.toBeUndefined();
  });

  it('survives the socket dropping mid-session, not only at teardown', async () => {
    const app = Fastify({ logger: false });
    await app.register(sessionPlugin, baseOpts);
    await app.ready();

    await severSockets();
    // Exercise the client AFTER the drop, so a reconnecting write is in flight
    // while the app shuts down — the exact overlap the full suite hits under
    // contention. The afterEach hook is what asserts no unhandled event.
    await app.inject({ method: 'GET', url: '/nope' }).catch(() => {});
    await app.close();
  });
});
