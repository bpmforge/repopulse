import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

describeIfLiveInfra('api app skeleton (W1-04)', () => {
  const db = createDb(databaseUrl as string);
  const baseOptions: BuildAppOptions = {
    db,
    tokenKey: Buffer.alloc(32, 7),
    webhookUrl: 'http://localhost/api/v1/webhooks/github',
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

  it('responds ok on /healthz (checks Postgres + Redis, no session required)', async () => {
    const app = buildApp(baseOptions);
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('serves an OpenAPI document at /api/v1/openapi.json without a session', async () => {
    const app = buildApp(baseOptions);
    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });

    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('RepoPulse API');

    await app.close();
  });

  it('returns RFC 7807 problem+json for an unknown route', async () => {
    const app = buildApp(baseOptions);
    const response = await app.inject({ method: 'GET', url: '/no-such-route' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 404, title: 'Not Found' });

    await app.close();
  });

  it('an unmatched path under /api/v1 falls through to the global 404 (no route registered there yet)', async () => {
    // apiV1's session/workspace preHandler is a per-route hook — it only
    // runs for requests that match a route registered inside that plugin's
    // encapsulated scope. Since no feature routes exist yet (later
    // tickets), an unmatched /api/v1/* path hits the global 404 handler
    // directly, same as any other unknown path. The guard itself is
    // exercised against a synthetic route in api-v1.test.ts.
    const app = buildApp(baseOptions);
    const response = await app.inject({ method: 'GET', url: '/api/v1/anything' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');

    await app.close();
  });
});
