import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from './index.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const MOCK_FORGE_USER_ID = '424242';

describeIfLiveInfra('auth routes E2E against a mocked GitHub (W1-03)', () => {
  let githubMock: Server;
  let githubMockBase: string;
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/login/oauth/access_token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'mock-access-token' }));
          return;
        }
        if (req.url === '/user') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: Number(MOCK_FORGE_USER_ID),
              login: 'octocat',
              name: 'The Octocat',
              avatar_url: 'https://example.com/a.png',
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => githubMock.listen(0, resolve));
    const address = githubMock.address();
    if (address === null || typeof address === 'string') throw new Error('mock did not bind');
    githubMockBase = `http://127.0.0.1:${address.port}`;

    app = Fastify();
    await app.register(authRoutes, {
      db,
      githubOAuth: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/auth/callback',
      },
      githubEndpoints: {
        tokenUrl: `${githubMockBase}/login/oauth/access_token`,
        userUrl: `${githubMockBase}/user`,
      },
      loginRedirectUrl: 'http://localhost:5173/',
      redisUrl: redisUrl as string,
      sessionSecret: 'test-session-secret-at-least-32-characters-long',
      idleTimeoutMs: 15 * 60 * 1000,
      absoluteLifetimeMs: 12 * 60 * 60 * 1000,
      cookieSecure: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      githubMock.close((err) => (err ? reject(err) : resolve())),
    );
    await db.delete(core.users).where(eq(core.users.forgeUserId, MOCK_FORGE_USER_ID));
    await db.$client.end();
  });

  it('completes the OAuth round trip to an authenticated session, then /me, then logout revokes it', async () => {
    // 1. GET /auth/login redirects to GitHub's authorize URL and sets a
    // signed, httpOnly state cookie.
    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    expect(loginRes.statusCode).toBe(302);
    const location = new URL(loginRes.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    const state = location.searchParams.get('state');
    expect(state).toBeTruthy();

    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state');
    expect(stateCookie).toBeDefined();
    expect(stateCookie?.httpOnly).toBe(true);
    expect(stateCookie?.sameSite).toBe('Lax');

    // 2. GET /auth/callback exchanges the code, fetches the mocked identity,
    // upserts the user, and creates a session.
    const callbackRes = await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: 'mock-code', state: state as string },
      cookies: { oauth_state: stateCookie!.value },
    });
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toBe('http://localhost:5173/');

    const sessionCookie = callbackRes.cookies.find((c) => c.name === 'repopulse_sid');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');
    expect(sessionCookie?.secure).toBeFalsy(); // cookieSecure:false in this harness

    // The old state cookie must be cleared on use.
    const clearedState = callbackRes.cookies.find((c) => c.name === 'oauth_state');
    expect(clearedState?.value).toBe('');

    // 3. GET /me returns the linked user using the session cookie only.
    const meRes = await app.inject({
      method: 'GET',
      url: '/me',
      cookies: { repopulse_sid: sessionCookie!.value },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = meRes.json();
    expect(meBody.user).toMatchObject({
      forgeUserId: MOCK_FORGE_USER_ID,
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://example.com/a.png',
    });

    // 4. POST /auth/logout revokes the session server-side.
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { repopulse_sid: sessionCookie!.value },
    });
    expect(logoutRes.statusCode).toBe(204);

    // 5. The now-revoked session cookie yields 401 with the RFC 7807 envelope.
    const meAfterLogoutRes = await app.inject({
      method: 'GET',
      url: '/me',
      cookies: { repopulse_sid: sessionCookie!.value },
    });
    expect(meAfterLogoutRes.statusCode).toBe(401);
    expect(meAfterLogoutRes.headers['content-type']).toContain('application/problem+json');
    const problem = meAfterLogoutRes.json();
    expect(problem.status).toBe(401);
    expect(problem.instance).toBe('/me');
  });

  it('GET /me with no session cookie at all is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('GET /auth/callback rejects a state that does not match the signed cookie', async () => {
    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state')!;

    const res = await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: 'mock-code', state: 'a-different-state' },
      cookies: { oauth_state: stateCookie.value },
    });
    // W20-04 (UX_TODO INS-14): back to the sign-in screen with a reason the
    // SPA can explain and the request id, not a raw JSON page.
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe('http://localhost:5173/');
    expect(location.searchParams.get('auth_error')).toBe('state_mismatch');
    expect(location.searchParams.get('request_id')).toBeTruthy();
  });

  it('GET /auth/callback with no state cookie at all goes back to sign-in', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: 'mock-code', state: 'whatever' },
    });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get('auth_error')).toBe(
      'missing_state_cookie',
    );
  });
});
