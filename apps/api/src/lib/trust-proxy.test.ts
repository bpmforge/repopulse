import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@repopulse/shared';
import { buildApp } from '../app.js';
import {
  DEFAULT_TRUST_PROXY_HOPS,
  isPrivateAddress,
  parseTrustProxy,
  trustHops,
  type TrustProxy,
  type TrustProxyFn,
} from './trust-proxy.js';

// W20-07 (UX_TODO INS-55). Behind the shipped nginx the API saw every browser
// as nginx, so the 10-a-minute sign-in limit was shared by the whole install.

describe('parseTrustProxy', () => {
  it('defaults to the one nginx hop the shipped stack has, from a private peer only', () => {
    expect(DEFAULT_TRUST_PROXY_HOPS).toBe(1);
    const fn = parseTrustProxy(undefined) as TrustProxyFn;
    expect(fn('10.89.0.5', 0)).toBe(true); // the web container
    expect(fn('192.0.2.10', 1)).toBe(false); // the client nginx saw: not a proxy
    // A public peer is a direct client, never a proxy whose header we read.
    expect(fn('203.0.113.7', 0)).toBe(false);
  });

  it('accepts hop counts, false/true and address lists, and rejects nonsense', () => {
    const two = parseTrustProxy('2') as TrustProxyFn;
    expect(two('172.18.0.2', 0) && two('198.51.100.1', 1) && !two('192.0.2.1', 2)).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('10.0.0.0/8, loopback')).toBe('10.0.0.0/8,loopback');
    expect(parseTrustProxy('nginx please')).toHaveProperty('error');
  });

  it('knows the private ranges, v4, v6 and v4-mapped', () => {
    for (const a of [
      '10.1.2.3',
      '127.0.0.1',
      '172.20.0.1',
      '192.168.1.9',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['172.32.0.1', '8.8.8.8', '2001:db8::1', '::ffff:8.8.8.8'])
      expect(isPrivateAddress(a), a).toBe(false);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

describeIfLiveInfra('sign-in rate limit behind a proxy (live)', () => {
  const db = createDb(databaseUrl as string);
  const apps: ReturnType<typeof buildApp>[] = [];

  function app(trustProxy: TrustProxy | undefined) {
    const built = buildApp({
      db,
      redisUrl: redisUrl as string,
      sessionSecret: 'w20-07-trust-proxy-session-secret-long-enough',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      tokenKey: Buffer.alloc(32),
      webhookUrl: 'http://localhost/hook',
      loginRedirectUrl: 'http://localhost/',
      ...(trustProxy !== undefined ? { trustProxy } : {}),
    });
    apps.push(built);
    return built;
  }

  beforeAll(async () => {
    await Promise.all(apps.map((a) => a.ready()));
  });

  afterAll(async () => {
    for (const a of apps) await a.close();
    await db.$client.end();
  });

  // Each attempt is a wrong password for an address that does not exist: a
  // 401 until the limiter answers 429.
  const attempt = (a: ReturnType<typeof buildApp>, client: string) =>
    a.inject({
      method: 'POST',
      url: '/auth/local/login',
      // What nginx sends: the address it saw, appended to X-Forwarded-For.
      headers: { 'x-requested-with': 'repopulse', 'x-forwarded-for': client },
      remoteAddress: '10.89.0.5', // the web container
      payload: { email: 'nobody-w20-07@example.com', password: 'not the password at all' },
    });

  it('keys the limit on the real client, so one person cannot lock out everyone', async () => {
    const a = app(trustHops(1));
    await a.ready();
    for (let i = 0; i < 10; i++) expect((await attempt(a, '192.0.2.10')).statusCode).toBe(401);
    expect((await attempt(a, '192.0.2.10')).statusCode).toBe(429);
    // A colleague behind the same nginx is not affected.
    expect((await attempt(a, '192.0.2.20')).statusCode).toBe(401);
  });

  it('a client cannot pick its own address by sending X-Forwarded-For itself', async () => {
    const a = app(trustHops(1));
    await a.ready();
    for (let i = 0; i < 10; i++) await attempt(a, '192.0.2.30');
    // nginx APPENDS, so the forged entry sits to the left of the real one and
    // one trusted hop never reads it.
    expect((await attempt(a, '203.0.113.99, 192.0.2.30')).statusCode).toBe(429);
  });
});
