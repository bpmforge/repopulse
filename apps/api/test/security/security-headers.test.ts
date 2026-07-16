import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../../src/app.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

function parseCsp(header: string): Record<string, string> {
  return Object.fromEntries(
    header
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...rest] = d.split(' ');
        return [name as string, rest.join(' ')];
      }),
  );
}

describeIfLiveInfra('SC-23 security headers (W1-08)', () => {
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

  it('serves the exact SECURITY_CONTROLS.md SC-23 CSP directives', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = parseCsp(res.headers['content-security-policy'] as string);
    expect(csp).toEqual({
      'default-src': "'self'",
      'script-src': "'self'",
      'object-src': "'none'",
      'frame-ancestors': "'none'",
      'base-uri': "'self'",
      'connect-src': "'self'",
    });
    await app.close();
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await app.close();
  });

  it('never emits Access-Control-Allow-Origin (CORS disabled)', async () => {
    const app = buildApp(baseOptions);
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
