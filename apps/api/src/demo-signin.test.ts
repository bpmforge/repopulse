import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { local } from '@repopulse/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from './routes/auth/index.js';
import localAuthRoutes from './routes/auth/local.js';
import authProviderRoutes from './routes/auth/providers.js';
import errorEnvelopePlugin from './plugins/error-envelope.js';
import csrfHeaderPlugin from './plugins/csrf-header.js';
import { DEMO_ACCOUNT } from './lib/demo.js';

// W16-02 (F1). The quickstart's own promise, as a test.
//
// README.md and docs/RUNNING.md tell a newcomer to run `DEMO_MODE=1 pnpm dev`
// and sign in. The screen puts an email/password form first, and that form went
// to the real local-credential path against a database with no local account —
// so the documented first run ended in "Invalid email or password" on screen
// one, while the boot banner claimed any login would work.
//
// Nothing caught it because demo mode had no test of its own: the e2e harness
// boots e2e/server.ts, not the demo entrypoint, and it authenticates through
// the mocked OAuth boundary — the one door that always worked. The form was the
// door nobody tried.
//
// These tests exercise the same two things demo.ts wires: the seeded account
// against the REAL login route (no bypass), and /auth/providers publishing the
// credentials so the sign-in screen can show them.

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const CSRF = { 'x-requested-with': 'repopulse' };

describeIfLiveInfra('demo mode sign-in (W16-02, F1)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);

  async function deleteDemoAccount(): Promise<void> {
    const rows = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.authSubject, DEMO_ACCOUNT.email));
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return;
    await db.delete(core.workspaceMembers).where(inArray(core.workspaceMembers.userId, ids));
    await db.delete(core.users).where(inArray(core.users.id, ids));
  }

  beforeAll(async () => {
    await deleteDemoAccount();

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    await app.register(csrfHeaderPlugin);
    await app.register(authRoutes, {
      db,
      sessionSecret: 'demo-signin-test-session-secret-at-least-32-bytes',
      redisUrl: redisUrl as string,
      cookieSecure: false,
      idleTimeoutMs: 15 * 60 * 1000,
      absoluteLifetimeMs: 12 * 60 * 60 * 1000,
      loginRedirectUrl: 'http://localhost:5273/',
    });
    await app.register(localAuthRoutes, { db });
    // Registered exactly as apps/api/src/app.ts does when the DEMO entrypoint
    // passes demoAccount — which is the only caller that ever does.
    await app.register(authProviderRoutes, { db, github: false, demo: DEMO_ACCOUNT });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await deleteDemoAccount();
    await db.$client.end();
  });

  it('the documented demo credentials sign in through the real local route', async () => {
    // Exactly what apps/api/src/demo.ts does at boot.
    const created = await local.createLocalUser(db, {
      email: DEMO_ACCOUNT.email,
      password: DEMO_ACCOUNT.password,
      name: 'Demo user',
      mustChangePassword: false,
    });
    expect(created.ok, 'the demo account must be creatable').toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: CSRF,
      payload: { email: DEMO_ACCOUNT.email, password: DEMO_ACCOUNT.password },
    });

    expect(res.statusCode, 'the demo credentials must be accepted').toBe(200);
    // The demo must not open on a password-change wall. The credential is
    // printed on the screen the person is looking at, so there is nobody to
    // protect it from — and a forced change would be a worse first run than the
    // bug this fixes.
    expect(res.json().must_change_password).toBe(false);
    expect(res.headers['set-cookie'], 'a real session cookie, not a mocked one').toBeDefined();
  });

  it('re-seeding on every boot is a no-op, not a failure', async () => {
    // demo.ts reseeds each start so a demo is never empty. The second call must
    // report `exists` rather than throwing, or the demo boots once and then
    // refuses for ever.
    const again = await local.createLocalUser(db, {
      email: DEMO_ACCOUNT.email,
      password: DEMO_ACCOUNT.password,
      mustChangePassword: false,
    });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toBe('exists');
  });

  it('a wrong password is still refused in demo mode', async () => {
    // The point of seeding an account rather than bypassing the route: demo
    // mode must not become a door that opens for anything typed into it.
    const res = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: CSRF,
      payload: { email: DEMO_ACCOUNT.email, password: 'not the demo password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('/auth/providers publishes the demo credentials so the sign-in screen can show them', async () => {
    // The sign-in screen cannot read /me/context — no session yet, so it 401s.
    // This anonymous endpoint is how the one screen that most needs the demo
    // banner learns it is in a demo at all (F2).
    const res = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(res.statusCode).toBe(200);
    expect(res.json().demo).toEqual({
      email: DEMO_ACCOUNT.email,
      password: DEMO_ACCOUNT.password,
    });
  });
});

describeIfLiveInfra('a non-demo install publishes no credentials (W16-02)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);

  beforeAll(async () => {
    app = Fastify();
    await app.register(errorEnvelopePlugin);
    // No `demo` option — the production entrypoint never passes one.
    await app.register(authProviderRoutes, { db, github: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.$client.end();
  });

  it('reports demo: null, so a real install cannot leak a password here', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(res.json().demo).toBeNull();
  });
});
