import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../../src/app.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

describeIfLiveInfra('SC-11 rate limiting (W1-08)', () => {
  const db = createDb(databaseUrl as string);
  const baseOptions: BuildAppOptions = {
    db,
    redisUrl: redisUrl as string,
    sessionSecret: 'test-session-secret-at-least-32-characters-long',
    idleTimeoutMs: 15 * 60 * 1000,
    absoluteLifetimeMs: 12 * 60 * 60 * 1000,
    cookieSecure: false,
    githubOAuth: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:3000/auth/callback',
    },
    loginRedirectUrl: 'http://localhost:5173/',
  };

  afterAll(async () => {
    await db.$client.end();
  });

  it('throttles /auth/login at 10/min/IP and returns 429 + rate-limit headers on the 11th', async () => {
    const app = buildApp(baseOptions);
    let last;
    for (let i = 0; i < 10; i++) {
      last = await app.inject({ method: 'GET', url: '/auth/login' });
      expect(last.statusCode).toBe(302);
    }
    const eleventh = await app.inject({ method: 'GET', url: '/auth/login' });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('does not rate-limit unrelated routes at the same threshold', async () => {
    const app = buildApp(baseOptions);
    for (let i = 0; i < 15; i++) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});
