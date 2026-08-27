import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from './index.js';
import authProviderRoutes from './providers.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

// The discovery half touches no database and no session, which is the point of
// testing it with a db that would throw if it were touched: a deployment's
// sign-in screen must be answerable before anyone is signed in, and before
// Postgres is even reachable.
const NO_DB = null as unknown as Database;

async function appOffering(opts: {
  oidc?: { displayName: string };
  github?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorEnvelopePlugin);
  await app.register(authProviderRoutes, { db: NO_DB, ...opts });
  await app.ready();
  return app;
}

describe('GET /auth/providers (W15-04)', () => {
  it('offers local only on a deployment that configured nothing else', async () => {
    const app = await appOffering({});
    const res = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(res.statusCode).toBe(200);
    // `demo: null` is part of the contract since W16-02: the sign-in screen is
    // the one screen with no session, so this anonymous endpoint is how it
    // learns whether it is looking at a demo. A REAL install must always say
    // null here — that is what keeps a credential out of a production response.
    expect(res.json()).toEqual({ local: true, oidc: null, github: false, demo: null });
    await app.close();
  });

  it('names the OIDC button the operator configured — "OIDC" means nothing to a user', async () => {
    const app = await appOffering({ oidc: { displayName: 'Acme SSO' } });
    expect(providersBody(await app.inject({ method: 'GET', url: '/auth/providers' })).oidc).toEqual({
      display_name: 'Acme SSO',
    });
    await app.close();
  });

  it('reports GitHub only when a GitHub App is configured', async () => {
    const withApp = await appOffering({ github: true });
    expect(providersBody(await withApp.inject({ method: 'GET', url: '/auth/providers' })).github).toBe(true);
    await withApp.close();

    // The defect this endpoint exists to prevent: /auth/login is not registered
    // on a deployment without an App, so a button for it leads to a 404.
    const without = await appOffering({});
    expect(providersBody(await without.inject({ method: 'GET', url: '/auth/providers' })).github).toBe(false);
    await without.close();
  });

  it('answers without a session — it is the screen a signed-out visitor sees', async () => {
    const app = await appOffering({ oidc: { displayName: 'Acme SSO' }, github: true });
    const answer = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(answer.statusCode).toBe(200);
    // No cookie was sent and none is set: nothing here is per-person.
    expect(answer.headers['set-cookie']).toBeUndefined();
    await app.close();
  });
});

function providersBody(reply: { json: () => unknown }): {
  local: boolean;
  oidc: { display_name: string } | null;
  github: boolean;
} {
  return reply.json() as { local: boolean; oidc: { display_name: string } | null; github: boolean };
}

// The identity half needs a real session and a real workspace, so it runs only
// against live infra — same gate as local.test.ts next door.
describeIfLiveInfra('GET /auth/identity (W15-04)', () => {
  let app: FastifyInstance;
  let userId: number;
  let cookie: string;
  const db = createDb(databaseUrl as string);
  const SUBJECT = 'w15-04-identity-probe';

  beforeAll(async () => {
    app = Fastify();
    await app.register(errorEnvelopePlugin);
    // authRoutes owns the session plugin; providers.ts deliberately registers
    // none of its own, exactly like local.ts.
    await app.register(authRoutes, {
      db,
      loginRedirectUrl: 'http://localhost:5173/',
      redisUrl: redisUrl as string,
      sessionSecret: 'test-session-secret-at-least-32-characters-long',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
    });
    await app.register(authProviderRoutes, { db });

    // A local-style account with NO forge link — the state this endpoint was
    // added for.
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: SUBJECT,
        login: SUBJECT,
        email: `${SUBJECT}@example.com`,
      })
      .onConflictDoUpdate({
        target: [core.users.authProvider, core.users.authSubject],
        set: { login: SUBJECT },
      })
      .returning();
    userId = user!.id;

    // A session is minted through the app's own session plugin rather than
    // hand-crafted, so the cookie this test sends is the one production issues.
    app.get('/testing/session', async (request, reply) => {
      request.session.set('userId', userId);
      request.session.set('createdAt', Date.now());
      await request.session.save();
      return reply.code(204).send();
    });
    await app.ready();
    const login = await app.inject({ method: 'GET', url: '/testing/session' });
    const issued = login.cookies.filter((c) => c.name === 'repopulse_sid' && c.value !== '').pop();
    if (!issued) throw new Error(`no session cookie on ${login.statusCode}: ${login.body}`);
    cookie = issued.value;
  });

  afterAll(async () => {
    await app.close();
    await db.delete(core.workspaceMembers).where(inArray(core.workspaceMembers.userId, [userId]));
    await db.delete(core.users).where(eq(core.users.id, userId));
  });

  it('401s without a session rather than guessing at a user', async () => {
    const answer = await app.inject({ method: 'GET', url: '/auth/identity' });
    expect(answer.statusCode).toBe(401);
  });

  it('reports `unlinked` for an account with no forge id', async () => {
    const answer = await app.inject({
      method: 'GET',
      url: '/auth/identity',
      cookies: { repopulse_sid: cookie },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ state: 'unlinked', identity_id: null });
  });

  it('reports `no_activity` once a forge id is claimed but nothing is ingested', async () => {
    // The distinction the UI turns into two different sentences: one is fixed
    // by claiming an identity, the other by writing some code.
    await db
      .update(core.users)
      .set({ forgeUserId: `${SUBJECT}-forge` })
      .where(eq(core.users.id, userId));
    const answer = await app.inject({
      method: 'GET',
      url: '/auth/identity',
      cookies: { repopulse_sid: cookie },
    });
    expect(answer.json()).toEqual({ state: 'no_activity', identity_id: null });
  });
});
