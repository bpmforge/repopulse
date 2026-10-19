import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, core, createDb, read, type Database } from '@repopulse/shared';
import { admission } from '@repopulse/auth';
import { buildApp } from '../../../app.js';
import { flushAuditWrites } from '../../../lib/audit-store.js';
import { loginAs } from '../../../testing/login.js';
import { csvCell } from './index.js';

const CSRF = { 'x-requested-with': 'repopulse' };
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

describe('csvCell (W20-10, UX_TODO X-04)', () => {
  it('quotes per RFC 4180 and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1+1')).toBe("'-1+1");
    expect(csvCell(null)).toBe('');
  });
});

// The persisted audit log (X-04) and GitHub sign-in's return_to (X-01) and
// org allowlist (INS-50), on one app: all three ride the real sign-in path.
describeIfLiveInfra('audit log + GitHub sign-in (W20-10)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let otherWorkspaceId: number;
  let adminUserId: number;
  let memberUserId: number;

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      const token = (req.headers.authorization ?? '').replace('Bearer ', '');
      if (req.url?.startsWith('/login/oauth/access_token')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const code =
            (JSON.parse(Buffer.concat(chunks).toString() || '{}') as { code?: string }).code ??
            'tok';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: code, token_type: 'bearer' }));
        });
        return;
      }
      if (req.url?.startsWith('/user/orgs')) {
        if (token.startsWith('w20-10-orgfail')) {
          res.writeHead(502);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            token.startsWith('w20-10-outsider') ? [{ login: 'elsewhere' }] : [{ login: 'Acme' }],
          ),
        );
        return;
      }
      if (req.url === '/user') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: token, login: token, name: null, avatar_url: null }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => githubMock.listen(0, r));
    const addr = githubMock.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock bind failed');
    const gh = `http://127.0.0.1:${addr.port}`;

    app = buildApp({
      db,
      tokenKey: Buffer.alloc(32),
      webhookUrl: 'http://localhost/hook',
      redisUrl: redisUrl as string,
      sessionSecret: 'w20-10-session-secret-that-is-long-enough-here',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: {
        tokenUrl: `${gh}/login/oauth/access_token`,
        userUrl: `${gh}/user`,
        orgsUrl: `${gh}/user/orgs`,
      },
      loginRedirectUrl: 'http://localhost/',
      admission: admission.admissionPolicyFromEnv({ SSO_ALLOWED_GITHUB_ORGS: 'acme' }),
    });
    await app.ready();

    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [other] = await db
      .insert(core.workspaces)
      .values({ slug: 'w20-10-other', name: 'Other' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Other' } })
      .returning();
    otherWorkspaceId = other!.id;
  });

  afterAll(async () => {
    await db.delete(read.auditEvents).where(eq(read.auditEvents.workspaceId, otherWorkspaceId));
    await db
      .delete(read.auditEvents)
      .where(inArray(read.auditEvents.event, ['w20-10.test' as never]));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, otherWorkspaceId));
    const ours = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(inArray(core.users.forgeUserId, ['w20-10-admin', 'w20-10-member', 'w20-10-back']));
    for (const u of ours) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, u.id));
      await db.delete(core.users).where(eq(core.users.id, u.id));
    }
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
    await db.$client.end();
  });

  async function session(forgeUserId: string, role: 'admin' | 'member'): Promise<[string, number]> {
    const cookie = await loginAs(app, forgeUserId);
    const [u] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, forgeUserId));
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: u!.id, role })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role },
      });
    return [cookie, u!.id];
  }

  describe('Settings → Audit log (X-04)', () => {
    let admin: string;

    beforeAll(async () => {
      [admin, adminUserId] = await session('w20-10-admin', 'admin');
      [, memberUserId] = await session('w20-10-member', 'member');
    });

    it('persists a real admin action and reads it back with the actor login', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/members/${memberUserId}`,
        headers: CSRF,
        cookies: { repopulse_sid: admin },
        payload: { role: 'member' },
      });
      expect(res.statusCode).toBe(200);
      await flushAuditWrites();

      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?event=admin.role.changed&limit=5',
        cookies: { repopulse_sid: admin },
      });
      expect(list.statusCode).toBe(200);
      const entry = list.json().items[0];
      expect(entry).toMatchObject({
        event: 'admin.role.changed',
        actor_user_id: adminUserId,
        actor_login: 'w20-10-admin',
      });
      expect(entry.detail).toMatchObject({ targetUserId: memberUserId, toRole: 'member' });
      expect(list.json().events).toContain('admin.role.changed');
    });

    it('never shows another workspace’s entries (Law 5)', async () => {
      auditLog(app.log, {
        event: 'w20-10.test' as never,
        actorUserId: null,
        workspaceId: otherWorkspaceId,
        secretMarker: 'other-tenant',
      } as never);
      await flushAuditWrites();
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?limit=200',
        cookies: { repopulse_sid: admin },
      });
      expect(res.body).not.toContain('other-tenant');
    });

    it('filters by actor and date, and pages with next_before', async () => {
      for (let i = 0; i < 3; i++) {
        auditLog(app.log, {
          event: 'w20-10.test' as never,
          actorUserId: adminUserId,
          workspaceId,
          n: i,
        } as never);
      }
      await flushAuditWrites();
      const page = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?event=w20-10.test&actor=w20-10-adm&limit=2',
        cookies: { repopulse_sid: admin },
      });
      const body = page.json();
      expect(body.items).toHaveLength(2);
      expect(body.next_before).toBe(body.items[1].id);
      const rest = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit?event=w20-10.test&before=${body.next_before}&limit=2`,
        cookies: { repopulse_sid: admin },
      });
      expect(rest.json().items[0].id).toBeLessThan(body.next_before);

      const today = new Date().toISOString().slice(0, 10);
      const inclusive = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit?event=w20-10.test&to=${today}`,
        cookies: { repopulse_sid: admin },
      });
      expect(inclusive.json().items.length).toBeGreaterThanOrEqual(3);
      const past = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?event=w20-10.test&to=2001-01-01',
        cookies: { repopulse_sid: admin },
      });
      expect(past.json().items).toHaveLength(0);

      const bad = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?from=yesterday-ish',
        cookies: { repopulse_sid: admin },
      });
      expect(bad.statusCode).toBe(400);
    });

    it('exports CSV', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit?event=w20-10.test&format=csv',
        cookies: { repopulse_sid: admin },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      const [header, first] = res.body.split('\n');
      expect(header).toBe('occurred_at,event,actor_user_id,actor_login,ip,detail');
      expect(first).toContain('w20-10.test');
    });

    it('is admin-only', async () => {
      const member = await loginAs(app, 'w20-10-member');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit',
        cookies: { repopulse_sid: member },
      });
      expect(res.statusCode).toBe(403);
      const anon = await app.inject({ method: 'GET', url: '/api/v1/admin/audit' });
      expect(anon.statusCode).toBe(401);
    });
  });

  describe('GitHub sign-in', () => {
    async function signIn(code: string, returnTo?: string) {
      const login = await app.inject({
        method: 'GET',
        url: '/auth/login',
        ...(returnTo === undefined ? {} : { query: { return_to: returnTo } }),
      });
      const state = new URL(login.headers.location as string).searchParams.get('state');
      const cookies: Record<string, string> = {};
      for (const c of login.cookies) if (c.value !== '') cookies[c.name] = c.value;
      return app.inject({
        method: 'GET',
        url: '/auth/callback',
        query: { code, state: state! },
        cookies,
      });
    }

    it('returns to the shared link it started from (X-01)', async () => {
      const res = await signIn('w20-10-back', '/findings?finding=812');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('http://localhost/findings?finding=812');
    });

    it('ignores an off-site return_to and lands on the root', async () => {
      const res = await signIn('w20-10-back', '//evil.example/steal');
      expect(res.headers.location).toBe('http://localhost/');
    });

    it('a tampered return cookie is ignored', async () => {
      const login = await app.inject({ method: 'GET', url: '/auth/login' });
      const state = new URL(login.headers.location as string).searchParams.get('state');
      const oauthState = login.cookies.find((c) => c.name === 'oauth_state')!.value;
      const res = await app.inject({
        method: 'GET',
        url: '/auth/callback',
        query: { code: 'w20-10-back', state: state! },
        cookies: { oauth_state: oauthState, auth_return_to: '/findings.unsigned' },
      });
      expect(res.headers.location).toBe('http://localhost/');
    });

    it('refuses an account outside the allowed orgs before it becomes a user (INS-50)', async () => {
      const res = await signIn('w20-10-outsider');
      expect(res.headers.location).toContain('auth_error=not_allowed');
      expect(res.cookies.find((c) => c.name === 'repopulse_sid' && c.value !== '')).toBeUndefined();
      const rows = await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.forgeUserId, 'w20-10-outsider'));
      expect(rows).toHaveLength(0);
    });

    it('says so when org membership cannot be checked', async () => {
      const res = await signIn('w20-10-orgfail');
      expect(res.headers.location).toContain('auth_error=org_check_failed');
    });
  });
});
