import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import { core, createDb, redactLine, type Logger } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuildAppOptions } from '../../src/app.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

interface AuditLine {
  audit?: boolean;
  event?: string;
  actorUserId?: number | null;
  workspaceId?: number | null;
  ip?: string;
  ua?: string | null;
  reason?: string;
  ts?: string;
}

function capturedLogger(): { logger: Logger; lines: () => AuditLine[] } {
  let raw = '';
  const dest = new Writable({
    write(chunk, _enc, cb) {
      raw += chunk.toString();
      cb();
    },
  });
  const logger = pino(
    { hooks: { streamWrite: (s: string) => redactLine(s) } },
    dest as unknown as pino.DestinationStream,
  );
  return {
    logger,
    lines: () =>
      raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditLine),
  };
}

const FORGE_USER_ID = 'w1-08-audit-test-user';

describeIfLiveInfra('SC-22 audit logging + SC-2 redaction (W1-08)', () => {
  let githubMock: Server;
  const db = createDb(databaseUrl as string);

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/login/oauth/access_token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'ghp_' + 'z'.repeat(36) }));
          return;
        }
        if (req.url === '/user') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: FORGE_USER_ID,
              login: FORGE_USER_ID,
              name: null,
              avatar_url: null,
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => githubMock.listen(0, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      githubMock.close((err) => (err ? reject(err) : resolve())),
    );
    const [user] = await db
      .select()
      .from(core.users)
      .where(eq(core.users.forgeUserId, FORGE_USER_ID))
      .limit(1);
    if (user) await db.delete(core.users).where(eq(core.users.id, user.id));
    await db.$client.end();
  });

  function baseOptions(loggerInstance: Logger): BuildAppOptions {
    const address = githubMock.address();
    if (address === null || typeof address === 'string') throw new Error('mock did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    return {
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
      githubEndpoints: { tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` },
      loginRedirectUrl: 'http://localhost:5173/',
      loggerInstance,
    };
  }

  it('emits an auth.login.success entry with actor/workspace/ip/ua/ts, and never leaks the access token', async () => {
    const { logger, lines } = capturedLogger();
    const app = buildApp(baseOptions(logger));

    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(loginRes.headers.location as string).searchParams.get('state');
    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state')!;
    await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: 'anything', state: state as string },
      cookies: { oauth_state: stateCookie.value },
      headers: { 'user-agent': 'vitest-audit-test' },
    });
    await app.close();

    const entries = lines();
    const successEntry = entries.find(
      (l) => l.audit === true && l.event === 'auth.login.success',
    ) as AuditLine;
    expect(successEntry).toBeTruthy();
    expect(successEntry).toMatchObject({
      event: 'auth.login.success',
      ip: expect.any(String),
      ua: 'vitest-audit-test',
      workspaceId: null,
    });
    expect(typeof successEntry.actorUserId).toBe('number');
    expect(typeof successEntry.ts).toBe('string');

    const rawJoined = JSON.stringify(entries);
    expect(rawJoined).not.toContain('ghp_' + 'z'.repeat(36));
  });

  it('emits an auth.login.failure entry with a reason on OAuth state mismatch', async () => {
    const { logger, lines } = capturedLogger();
    const app = buildApp(baseOptions(logger));

    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state')!;
    await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: 'anything', state: 'wrong-state-value' },
      cookies: { oauth_state: stateCookie.value },
    });
    await app.close();

    const failureEntry = lines().find(
      (l) => l.audit === true && l.event === 'auth.login.failure',
    ) as AuditLine;
    expect(failureEntry).toMatchObject({ event: 'auth.login.failure', reason: 'state_mismatch' });
    expect(failureEntry.actorUserId).toBeNull();
  });

  it('emits an auth.logout entry carrying the actor', async () => {
    const { logger, lines } = capturedLogger();
    const app = buildApp(baseOptions(logger));

    const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(loginRes.headers.location as string).searchParams.get('state');
    const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state')!;
    const callbackRes = await app.inject({
      method: 'GET',
      url: '/auth/callback',
      query: { code: 'anything', state: state as string },
      cookies: { oauth_state: stateCookie.value },
    });
    const sessionCookie = callbackRes.cookies.find((c) => c.name === 'repopulse_sid')!;

    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { repopulse_sid: sessionCookie.value },
      headers: { 'x-requested-with': 'repopulse' },
    });
    await app.close();

    const logoutEntry = lines().find(
      (l) => l.audit === true && l.event === 'auth.logout',
    ) as AuditLine;
    expect(logoutEntry).toBeTruthy();
    expect(typeof logoutEntry.actorUserId).toBe('number');
  });
});
