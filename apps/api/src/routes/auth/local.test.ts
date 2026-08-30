import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, deleteAllLocalUsers } from '@repopulse/shared';
import { local } from '@repopulse/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from './index.js';
import localAuthRoutes from './local.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import csrfHeaderPlugin from '../../plugins/csrf-header.js';
import apiV1 from '../../plugins/api-v1.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const ADMIN_EMAIL = 'w15-02-admin@example.com';
const ADMIN_PASSWORD = 'bootstrap passphrase one';
// SC-7: every non-safe request carries this or the CSRF plugin 403s it. Sent
// even where a test could get away without it, because a test that passes
// without the header is a test that would not notice production requiring it.
const CSRF = { 'x-requested-with': 'repopulse' };
const ADMIN_NEW_PASSWORD = 'the admin chose this one';

describeIfLiveInfra('local sign-in routes (W15-02)', () => {
  let app: FastifyInstance;
  let adminCookie: string;
  const db = createDb(databaseUrl as string);


  beforeAll(async () => {
    await deleteAllLocalUsers(db);

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    await app.register(csrfHeaderPlugin);
    // The GitHub half is registered for one reason: it owns the session plugin.
    // This composition is also the proof that the two route modules coexist —
    // registering @fastify/session twice would throw here on the duplicate
    // cookie decorator, which is why local.ts registers nothing of its own.
    await app.register(authRoutes, {
      db,
      githubOAuth: {
        clientId: 'unused-in-this-suite',
        clientSecret: 'unused-in-this-suite',
        redirectUri: 'http://localhost:3000/auth/callback',
      },
      loginRedirectUrl: 'http://localhost:5173/',
      redisUrl: redisUrl as string,
      sessionSecret: 'test-session-secret-at-least-32-characters-long',
      idleTimeoutMs: 15 * 60 * 1000,
      absoluteLifetimeMs: 12 * 60 * 60 * 1000,
      cookieSecure: false,
    });
    await app.register(localAuthRoutes, { db });
    // The real guarded scope, so "cannot reach anything else" is tested against
    // an actual product route rather than a stand-in that agrees with us.
    // NOTE: plugins/rate-limits is deliberately NOT registered — this suite
    // makes more than AUTH_FLOW_RATE_LIMIT's ten attempts a minute on purpose.
    await app.register(apiV1, {
      db,
      redisUrl: redisUrl as string,
      tokenKey: Buffer.alloc(32),
      webhookUrl: 'http://localhost:3000/webhooks/github',
      enqueueBackfillPlan: async () => {},
      prefix: '/api/v1',
    });
    await app.ready();

    const bootstrapped = await local.ensureBootstrapAdmin(db, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(bootstrapped.status).toBe('created');
  });

  afterAll(async () => {
    await app.close();
    await deleteAllLocalUsers(db);
  });

  async function login(email: string, password: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: CSRF,
      payload: { email, password },
    });
  }

  // `session.regenerate()` emits TWO Set-Cookie headers for the same name: an
  // expiry for the old id, then the new one. A browser applies them in order
  // and keeps the last, so a test that takes the FIRST match reads the empty
  // clearing cookie and concludes it was never signed in.
  function sid(res: Awaited<ReturnType<typeof login>>): string {
    const issued = res.cookies.filter((c) => c.name === 'repopulse_sid' && c.value !== '');
    const cookie = issued[issued.length - 1];
    if (!cookie) throw new Error(`no session cookie on ${res.statusCode}: ${res.body}`);
    return cookie.value;
  }

  function maybeSid(res: Awaited<ReturnType<typeof login>>): string | undefined {
    return res.cookies.filter((c) => c.name === 'repopulse_sid' && c.value !== '').pop()?.value;
  }

  describe('the forced password change gate', () => {
    let pendingCookie: string;

    it('signs the bootstrap admin in but does not authenticate them', async () => {
      const res = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ must_change_password: true });
      // No user object either: nothing about the account is readable until the
      // password that let them in stops being the one someone else typed.
      pendingCookie = sid(res);
    });

    it('reaches nothing else while the change is pending', async () => {
      const guarded = await app.inject({
        method: 'GET',
        url: '/api/v1/me/context',
        cookies: { repopulse_sid: pendingCookie },
      });
      expect(guarded.statusCode).toBe(401);

      // Not even the account-creation route in this very module, which reads
      // `userId` and therefore sees a pending session as nobody.
      const create = await app.inject({
        method: 'POST',
        url: '/auth/local/users',
        headers: CSRF,
        cookies: { repopulse_sid: pendingCookie },
        payload: { email: 'sneaky@example.com' },
      });
      expect(create.statusCode).toBe(401);
    });

    it('tells the SPA why, so a page reload does not strand the user', async () => {
      const status = await app.inject({
        method: 'GET',
        url: '/auth/local/session',
        cookies: { repopulse_sid: pendingCookie },
      });
      expect(status.json()).toEqual({ pending_password_change: true });

      const anonymous = await app.inject({ method: 'GET', url: '/auth/local/session' });
      expect(anonymous.json()).toEqual({ pending_password_change: false });
    });

    it('refuses a change that keeps the same password, or gets the old one wrong', async () => {
      const wrongCurrent = await app.inject({
        method: 'POST',
        url: '/auth/local/password',
        headers: CSRF,
        cookies: { repopulse_sid: pendingCookie },
        payload: { current_password: 'not it at all', new_password: 'a whole new passphrase' },
      });
      expect(wrongCurrent.statusCode).toBe(401);

      const unchanged = await app.inject({
        method: 'POST',
        url: '/auth/local/password',
        headers: CSRF,
        cookies: { repopulse_sid: pendingCookie },
        payload: { current_password: ADMIN_PASSWORD, new_password: ADMIN_PASSWORD },
      });
      expect(unchanged.statusCode).toBe(400);

      const tooShort = await app.inject({
        method: 'POST',
        url: '/auth/local/password',
        headers: CSRF,
        cookies: { repopulse_sid: pendingCookie },
        payload: { current_password: ADMIN_PASSWORD, new_password: 'short' },
      });
      expect(tooShort.statusCode).toBe(400);

      // Still pending after all three — a rejected change must not open the gate.
      const stillPending = await app.inject({
        method: 'GET',
        url: '/auth/local/session',
        cookies: { repopulse_sid: pendingCookie },
      });
      expect(stillPending.json()).toEqual({ pending_password_change: true });
    });

    it('opens only when a new password is actually stored, on a new session id', async () => {
      const changed = await app.inject({
        method: 'POST',
        url: '/auth/local/password',
        headers: CSRF,
        cookies: { repopulse_sid: pendingCookie },
        payload: { current_password: ADMIN_PASSWORD, new_password: ADMIN_NEW_PASSWORD },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().user.must_change_password).toBe(false);

      adminCookie = sid(changed);
      // Session fixation: the id that carried the pending state is not the id
      // that carries the authenticated one.
      expect(adminCookie).not.toBe(pendingCookie);

      const guarded = await app.inject({
        method: 'GET',
        url: '/api/v1/me/context',
        cookies: { repopulse_sid: adminCookie },
      });
      expect(guarded.statusCode).toBe(200);

      // And the old id is dead, not merely superseded.
      const stale = await app.inject({
        method: 'GET',
        url: '/api/v1/me/context',
        cookies: { repopulse_sid: pendingCookie },
      });
      expect(stale.statusCode).toBe(401);
    });

    it('lets a pending session walk away, which /auth/logout cannot do for it', async () => {
      // Fresh pending session: create a user, log in, then abandon it.
      const created = await app.inject({
        method: 'POST',
        url: '/auth/local/users',
        headers: CSRF,
        cookies: { repopulse_sid: adminCookie },
        payload: { email: 'walkaway@example.com' },
      });
      expect(created.statusCode).toBe(201);
      const temp = created.json().temporary_password as string;

      const pending = sid(await login('walkaway@example.com', temp));
      const viaSharedLogout = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: CSRF,
        cookies: { repopulse_sid: pending },
      });
      // 204, but a no-op: that route only destroys a session carrying `userId`.
      expect(viaSharedLogout.statusCode).toBe(204);
      const survived = await app.inject({
        method: 'GET',
        url: '/auth/local/session',
        cookies: { repopulse_sid: pending },
      });
      expect(survived.json()).toEqual({ pending_password_change: true });

      const ours = await app.inject({
        method: 'POST',
        url: '/auth/local/logout',
        headers: CSRF,
        cookies: { repopulse_sid: pending },
      });
      expect(ours.statusCode).toBe(204);
      const gone = await app.inject({
        method: 'GET',
        url: '/auth/local/session',
        cookies: { repopulse_sid: pending },
      });
      expect(gone.json()).toEqual({ pending_password_change: false });
    });
  });

  describe('failed sign-ins are indistinguishable', () => {
    it('returns the identical response for an unknown address and a wrong password', async () => {
      const unknown = await login('nobody-here@example.com', 'some plausible password');
      const wrong = await login(ADMIN_EMAIL, 'some plausible password');
      expect(unknown.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      // `instance` and `request_id` differ per request by design; everything
      // that describes WHAT went wrong must match exactly.
      const strip = (res: typeof unknown) => {
        const { instance, request_id, ...rest } = res.json();
        void instance;
        void request_id;
        return rest;
      };
      expect(strip(unknown)).toEqual(strip(wrong));
      expect(unknown.headers['content-type']).toBe(wrong.headers['content-type']);
      // No session is issued on either path.
      expect(maybeSid(unknown)).toBeUndefined();
      expect(maybeSid(wrong)).toBeUndefined();
    });

    it('takes comparable time on both paths', async () => {
      const median = async (email: string): Promise<number> => {
        const samples: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const started = process.hrtime.bigint();
          await login(email, 'some plausible password');
          samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        }
        return samples.sort((a, b) => a - b)[2] as number;
      };
      const unknown = await median('nobody-here@example.com');
      const known = await median(ADMIN_EMAIL);
      // Loose on purpose: the claim is "a derivation happens either way", and a
      // tight bound would only make this flake on a busy machine.
      expect(unknown).toBeGreaterThan(10);
      expect(unknown / known).toBeGreaterThan(0.4);
      expect(unknown / known).toBeLessThan(2.5);
    });
  });

  describe('accounts come from an admin, never from a signup form', () => {
    it('has no self-service registration route', async () => {
      for (const url of ['/auth/local/register', '/auth/local/signup', '/auth/register']) {
        const res = await app.inject({ method: 'POST', url, headers: CSRF, payload: {} });
        expect(res.statusCode).toBe(404);
      }
    });

    it('creates a user with a one-time password and a forced change', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/local/users',
        headers: CSRF,
        cookies: { repopulse_sid: adminCookie },
        payload: { email: 'Newbie@Example.com', name: 'New Bie' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.user.email).toBe('newbie@example.com');
      expect(body.user.must_change_password).toBe(true);
      expect(body.user).not.toHaveProperty('password_hash');
      expect(typeof body.temporary_password).toBe('string');
      expect(body.temporary_password.length).toBeGreaterThan(20);

      // The generated password works exactly once, into a pending session.
      const signedIn = await login('newbie@example.com', body.temporary_password);
      expect(signedIn.json()).toEqual({ must_change_password: true });

      // A duplicate is refused rather than silently resetting the account.
      const again = await app.inject({
        method: 'POST',
        url: '/auth/local/users',
        headers: CSRF,
        cookies: { repopulse_sid: adminCookie },
        payload: { email: 'newbie@example.com' },
      });
      expect(again.statusCode).toBe(409);
    });

    it('does not echo a password the admin supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/local/users',
        headers: CSRF,
        cookies: { repopulse_sid: adminCookie },
        payload: { email: 'chosen@example.com', password: 'an admin chosen passphrase' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).not.toHaveProperty('temporary_password');
      expect(res.body).not.toContain('an admin chosen passphrase');
    });

    it('refuses a non-admin and an anonymous caller', async () => {
      const anonymous = await app.inject({
        method: 'POST',
        url: '/auth/local/users',
        headers: CSRF,
        payload: { email: 'nope@example.com' },
      });
      expect(anonymous.statusCode).toBe(401);

      // A real member: created by the admin, then promoted out of the pending
      // state so the 403 is about ROLE and not about the password gate.
      const created = await app.inject({
        method: 'POST',
        url: '/auth/local/users',
        headers: CSRF,
        cookies: { repopulse_sid: adminCookie },
        payload: { email: 'member@example.com' },
      });
      const temp = created.json().temporary_password as string;
      const pending = sid(await login('member@example.com', temp));
      const promoted = await app.inject({
        method: 'POST',
        url: '/auth/local/password',
        headers: CSRF,
        cookies: { repopulse_sid: pending },
        payload: { current_password: temp, new_password: 'the members own passphrase' },
      });
      expect(promoted.statusCode).toBe(200);
      const memberCookie = sid(promoted);

      const forbidden = await app.inject({
        method: 'POST',
        url: '/auth/local/users',
        headers: CSRF,
        cookies: { repopulse_sid: memberCookie },
        payload: { email: 'nope@example.com' },
      });
      expect(forbidden.statusCode).toBe(403);
    });
  });

  it('requires the CSRF header like every other non-safe route', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it('signs the admin in normally once the password has been changed', async () => {
    const res = await login(ADMIN_EMAIL, ADMIN_NEW_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json().must_change_password).toBe(false);
    expect(res.json().user.email).toBe(ADMIN_EMAIL);
    const guarded = await app.inject({
      method: 'GET',
      url: '/api/v1/me/context',
      cookies: { repopulse_sid: sid(res) },
    });
    expect(guarded.statusCode).toBe(200);
  });
});
