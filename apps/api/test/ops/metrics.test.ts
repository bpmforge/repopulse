import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../../src/app.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

describeIfLiveInfra('ops endpoints: /healthz + /metrics (W1-09)', () => {
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

  it('GET /healthz is unauthenticated and checks Postgres + Redis', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /metrics is unauthenticated, serves Prometheus text, and includes the §3 forge metric names', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    for (const name of [
      'forge_requests_total',
      'forge_304_total',
      'forge_points_spent',
      'forge_budget_remaining',
      'forge_queue_depth',
    ]) {
      expect(res.body).toContain(`# TYPE ${name} `);
    }
    await app.close();
  });

  it('records HTTP request duration observations, labeled by route pattern', async () => {
    const app = buildApp(baseOptions);
    await app.inject({ method: 'GET', url: '/healthz' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('http_request_duration_seconds_bucket');
    expect(res.body).toContain('route="/healthz"');
    expect(res.body).toContain('method="GET"');
    await app.close();
  });

  it('/healthz is exempt from the FR-API-4 route walker (same treatment as /auth/* and /webhooks/*)', async () => {
    // The exemption itself lives in packages/shared/src/testing/route-walker.ts's
    // DEFAULT_EXEMPT_PREFIXES (W1-07) and doesn't need to change here since
    // /healthz's URL is unchanged by this ticket's refactor - only which
    // module owns the handler moved. This test just re-confirms the URL
    // stayed the same after the extraction into routes/health/**.
    const app = buildApp(baseOptions);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
