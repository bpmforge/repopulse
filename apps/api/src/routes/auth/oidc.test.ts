import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { session as sessionModule } from '@repopulse/auth';
import { startFixtureIdp, type FixtureIdp } from '@repopulse/auth/src/oidc/fixture-idp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import oidcRoutes from './oidc.js';

// The OIDC login routes against a fixture OpenID Provider running in this
// process (W15-03). Postgres and Redis are real because the point of the test
// is that a login ENDS in a session and a user row — the same live-infra gate
// the GitHub OAuth route test uses.

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const CLIENT_ID = 'repopulse-oidc-route-test';
const CLIENT_SECRET = 'repopulse-oidc-route-secret';
const REDIRECT_URI = 'http://localhost:3300/auth/oidc/callback';
const SUBJECT = 'oidc-route-test-subject';

describeIfLiveInfra('OIDC login routes against a fixture IdP (W15-03)', () => {
  let idp: FixtureIdp;
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);

  beforeAll(async () => {
    idp = await startFixtureIdp({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      claims: { sub: SUBJECT, email: 'ada@example.test', preferred_username: 'ada', name: 'Ada' },
    });

    app = Fastify();
    // Registered here because the real app registers it once, inside
    // routes/auth/index.ts, through fastify-plugin — this plugin assumes
    // `request.session` already exists and must never register a second copy.
    await app.register(sessionModule.sessionPlugin, {
      redisUrl: redisUrl as string,
      sessionSecret: 'test-session-secret-at-least-32-characters-long',
      idleTimeoutMs: 15 * 60 * 1000,
      absoluteLifetimeMs: 12 * 60 * 60 * 1000,
      cookieSecure: false,
    });
    await app.register(oidcRoutes, {
      db,
      config: {
        issuer: idp.issuer,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        scopes: 'openid profile email',
        displayName: 'Test SSO',
      },
      loginRedirectUrl: 'http://localhost:5173/',
      cookieSecure: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await idp.close();
    await db
      .delete(core.users)
      .where(and(eq(core.users.authProvider, 'oidc'), eq(core.users.authSubject, SUBJECT)));
    await db.$client.end();
  });

  async function startLogin(): Promise<{ authorizeUrl: string; state: string; cookie: string }> {
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/login' });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    const cookie = res.cookies.find((c) => c.name === 'oidc_tx');
    expect(cookie, 'login must set the transaction cookie').toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    return {
      authorizeUrl: location,
      state: new URL(location).searchParams.get('state') as string,
      cookie: cookie!.value,
    };
  }

  /**
   * W20-04 (UX_TODO INS-14): a failed callback is a browser navigation, so it
   * lands on the sign-in screen with a code and the request id — never on a
   * raw problem+json page with no way back.
   */
  function expectBackAtSignIn(
    res: { statusCode: number; headers: Record<string, unknown> },
    code: string,
  ) {
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe('http://localhost:5173/');
    expect(location.searchParams.get('auth_error')).toBe(code);
    expect(location.searchParams.get('request_id')).toBeTruthy();
  }

  it('completes discovery → redirect → exchange → verification → session → user row', async () => {
    const { authorizeUrl, state, cookie } = await startLogin();

    const url = new URL(authorizeUrl);
    expect(url.origin).toBe(idp.issuer);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('scope')).toContain('openid');

    const code = idp.authorize(authorizeUrl);
    const callback = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback',
      query: { code, state },
      cookies: { oidc_tx: cookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('http://localhost:5173/');

    const sessionCookie = callback.cookies.find((c) => c.name === 'repopulse_sid');
    expect(sessionCookie?.httpOnly).toBe(true);

    // The transaction cookie is spent, whatever the outcome.
    expect(callback.cookies.find((c) => c.name === 'oidc_tx')?.value).toBe('');

    // The IdP really did receive a PKCE verifier, and the secret went in the
    // Authorization header rather than the form body.
    const lastTokenRequest = idp.tokenRequests().at(-1);
    expect(lastTokenRequest?.['code_verifier']).toBeTruthy();
    expect(lastTokenRequest?.['client_secret']).toBeUndefined();

    const [user] = await db
      .select()
      .from(core.users)
      .where(and(eq(core.users.authProvider, 'oidc'), eq(core.users.authSubject, SUBJECT)))
      .limit(1);
    expect(user, 'the login must have created a user keyed on the IdP subject').toBeDefined();
    expect(user?.email).toBe('ada@example.test');
    expect(user?.login).toBe('ada');
    // D14: an OIDC login says nothing about who commits under which forge
    // account, so the forge link stays unclaimed rather than guessed.
    expect(user?.forgeUserId).toBeNull();
  });

  it('rejects a callback whose state does not match the cookie — the CSRF case', async () => {
    const { authorizeUrl, cookie } = await startLogin();
    const code = idp.authorize(authorizeUrl);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback',
      query: { code, state: 'state-the-attacker-chose' },
      cookies: { oidc_tx: cookie },
    });
    expectBackAtSignIn(res, 'state_mismatch');
    expect(res.cookies.find((c) => c.name === 'repopulse_sid')).toBeUndefined();
  });

  it('rejects a callback with no transaction cookie at all', async () => {
    const { authorizeUrl, state } = await startLogin();
    const code = idp.authorize(authorizeUrl);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback',
      query: { code, state },
    });
    expectBackAtSignIn(res, 'missing_state_cookie');
  });

  it('rejects an UNSIGNED transaction cookie the caller minted themselves', async () => {
    // Without the signature check, an attacker could hand us a cookie whose
    // state matches the state they put in the URL, and state would prove
    // nothing at all.
    const { authorizeUrl, state } = await startLogin();
    const code = idp.authorize(authorizeUrl);
    const forged = Buffer.from(
      JSON.stringify({ state, nonce: 'x', verifier: 'y' }),
      'utf8',
    ).toString('base64url');
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback',
      query: { code, state },
      cookies: { oidc_tx: forged },
    });
    expectBackAtSignIn(res, 'state_mismatch');
  });

  it('does not start a session when the provider reports an error', async () => {
    const { cookie } = await startLogin();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback',
      query: { error: 'access_denied', state: 'whatever' },
      cookies: { oidc_tx: cookie },
    });
    expectBackAtSignIn(res, 'oidc_provider_error');
    // The provider's own error text is never echoed into the URL.
    expect(res.headers.location).not.toContain('access_denied');
    expect(res.cookies.find((c) => c.name === 'repopulse_sid')).toBeUndefined();
  });
});
