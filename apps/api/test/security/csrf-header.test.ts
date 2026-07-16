import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../../src/app.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

describeIfLiveInfra('SC-7 CSRF header stance (W1-08)', () => {
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

  it('rejects a mutation without X-Requested-With with 403 problem+json', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toContain('application/problem+json');
    await app.close();
  });

  it('accepts a mutation carrying X-Requested-With: repopulse', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'x-requested-with': 'repopulse' },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('rejects the wrong X-Requested-With value', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('never requires the header on safe methods (GET)', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
