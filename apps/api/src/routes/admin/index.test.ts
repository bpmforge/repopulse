import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { core, createDb, redactLine, type Database, type Logger } from '@repopulse/shared';
import type { Job, Queue } from 'bullmq';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';

// SC-7: every non-safe method needs this header or an onRequest hook 403s the
// request before any route logic runs — which presents as "the admin guard
// rejected me" rather than "you forgot a header".
const CSRF = { 'x-requested-with': 'repopulse' };

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

interface AuditLine {
  audit?: boolean;
  event?: string;
  actorUserId?: number | null;
  targetUserId?: number;
  fromRole?: string | null;
  toRole?: string;
  queue?: string;
  failureId?: number;
}

/**
 * Captures audit output at the pino DESTINATION (W12-09).
 *
 * Not by stubbing `app.log.info`: `request.log` is a pino CHILD logger, so a
 * stub on the parent's method sees nothing and the test passes against a route
 * that logs nothing at all. The destination is the only place both are visible.
 */
function auditCapture(): { logger: Logger; lines: () => AuditLine[]; reset: () => void } {
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
        .map((l) => JSON.parse(l) as AuditLine)
        .filter((l) => l.audit === true),
    reset: () => {
      raw = '';
    },
  };
}

const audit = auditCapture();

// Admin members + DLQ (W4-20).
//
// The DLQ half is the one that matters: W12-05 deliberately left the queue
// unconsumed so a human could inspect and replay, and until these routes
// existed there was no way to do the inspecting.

describeIfLiveInfra('admin routes (W4-20, FR-AUTH-4 / NFR-11)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let adminUserId: number;
  let memberUserId: number;
  let otherWorkspaceId: number;
  let otherFailureId: number;
  const added: { name: string; data: unknown }[] = [];

  const fakeQueue = {
    add: (name: string, data: unknown) => {
      added.push({ name, data });
      return Promise.resolve({} as Job);
    },
    close: () => Promise.resolve(),
  } as unknown as Queue;

  beforeAll(async () => {
    // The OAuth boundary is faked the same way every other route test fakes it;
    // without it the shared login helper reports a 502 from the token exchange,
    // which is at least now what it SAYS rather than a TypeError.
    githubMock = createServer((req, res) => {
      if (req.url?.startsWith('/login/oauth/access_token')) {
        // The exchange POSTs a JSON BODY, not a query string — reading `code`
        // from the URL silently yielded a fixed token, so every login resolved
        // to the SAME user and the admin and member fixtures collapsed into one.
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString() || '{}';
          const code = (JSON.parse(body) as { code?: string }).code ?? 'tok';
          // Echoing the code back as the token is what lets /user below mint a
          // distinct identity per fixture user.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: code, token_type: 'bearer' }));
        });
        return;
      }
      if (req.url === '/user') {
        const f = (req.headers.authorization ?? '').replace('Bearer ', '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: f, login: f, name: null, avatar_url: null }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => githubMock.listen(0, r));
    const addr = githubMock.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock bind failed');
    const ghBase = `http://127.0.0.1:${addr.port}`;

    app = buildApp({
      db,
      tokenKey: Buffer.alloc(32),
      webhookUrl: 'http://localhost/hook',
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
      sessionSecret: 'w4-20-session-secret-that-is-long-enough-here',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: {
        tokenUrl: `${ghBase}/login/oauth/access_token`,
        userUrl: `${ghBase}/user`,
      },
      loginRedirectUrl: 'http://localhost/',
      adminQueueFor: () => fakeQueue,
      loggerInstance: audit.logger,
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
      .values({ slug: 'w4-20-other', name: 'Other' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Other' } })
      .returning();
    otherWorkspaceId = other!.id;

    const [member] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w4-20-member', forgeUserId: 'w4-20-member', login: 'w4-20-member' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w4-20-member' } })
      .returning();
    memberUserId = member!.id;
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: memberUserId, role: 'member' })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role: 'member' },
      });

    const [row] = await db
      .insert(core.jobFailure)
      .values({
        workspaceId: otherWorkspaceId,
        queue: 'ingest.backfill',
        jobId: 'other-tenant-job',
        payload: { workspaceId: otherWorkspaceId, repoId: 1 },
        error: 'boom',
      })
      .returning();
    otherFailureId = row!.id;
  });

  afterAll(async () => {
    await db.delete(core.jobFailure).where(eq(core.jobFailure.workspaceId, workspaceId));
    await db.delete(core.jobFailure).where(eq(core.jobFailure.workspaceId, otherWorkspaceId));
    await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, memberUserId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w4-20-member'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, otherWorkspaceId));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
    await db.$client.end();
  });

  async function adminSession(): Promise<string> {
    const cookie = await loginAs(app, 'w4-20-admin');
    const [u] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, 'w4-20-admin'));
    adminUserId = u!.id;
    // UPSERT rather than UPDATE: whether this user is already a member depends
    // on whether the workspace already had one (FR-AUTH-3 makes the first
    // joiner admin, later joiners members), and an UPDATE that matches nothing
    // fails silently — which presents as an unexplained 403 from the guard.
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: adminUserId, role: 'admin' })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role: 'admin' },
      });
    return cookie;
  }

  it('lists members with their roles', async () => {
    const cookie = await adminSession();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/members',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { login: string; role: string }[] };
    expect(body.items.map((i) => i.login)).toContain('w4-20-member');
    expect(body.items.find((i) => i.login === 'w4-20-member')?.role).toBe('member');
  });

  it('changes a member role', async () => {
    const cookie = await adminSession();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${memberUserId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user_id: memberUserId, role: 'admin' });
  });

  it('rejects an unknown role rather than writing it', async () => {
    const cookie = await adminSession();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${memberUserId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { role: 'superuser' },
    });
    // The DB CHECK would also reject it, but a 500 from a constraint is not an
    // answer an operator can act on.
    expect(res.statusCode).toBe(400);
  });

  it('refuses to demote the LAST admin — that would lock the workspace out', async () => {
    const cookie = await adminSession();
    // Make the caller the only admin — EVERY other admin, not just this
    // suite's own member. The warehouse seeder also makes its fixture user an
    // admin of this workspace, so demoting one known id left two admins and
    // the refusal never fired; the test then passed or failed depending on
    // whether the seeder had run recently, which is not a property a test
    // should have.
    await db
      .update(core.workspaceMembers)
      .set({ role: 'member' })
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          ne(core.workspaceMembers.userId, adminUserId),
        ),
      );

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${adminUserId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { role: 'member' },
    });
    // 409, not 400: the request is well-formed, the STATE forbids it.
    expect(res.statusCode).toBe(409);
    const [still] = await db
      .select({ role: core.workspaceMembers.role })
      .from(core.workspaceMembers)
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          eq(core.workspaceMembers.userId, adminUserId),
        ),
      );
    expect(still!.role, 'the demotion must not have partially applied').toBe('admin');
  });

  // W16-59. Until the foreign-key migration that preceded this, a member who
  // had used RepoPulse could not be removed at all: every users FK was NO
  // ACTION, so generating one report or triaging one finding made the account
  // permanently undeletable. These pin the guards on the endpoint that now
  // makes the migration something the product actually offers.
  it('removes a member', async () => {
    const cookie = await adminSession();
    // Its OWN throwaway account, not the shared fixture member: this test is
    // the one that destroys what it touches, and the suite's other tests need
    // that member to still exist.
    const [doomed] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w16-59-doomed',
        forgeUserId: 'w16-59-doomed',
        login: 'w16-59-doomed',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w16-59-doomed' } })
      .returning();
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: doomed!.id, role: 'member' })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role: 'member' },
      });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/members/${doomed!.id}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
    });
    expect(res.statusCode).toBe(200);

    const left = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.id, doomed!.id));
    expect(left, 'the account is gone').toEqual([]);
    // And the membership went with it — the one place a CASCADE is right.
    const membership = await db
      .select({ userId: core.workspaceMembers.userId })
      .from(core.workspaceMembers)
      .where(eq(core.workspaceMembers.userId, doomed!.id));
    expect(membership).toEqual([]);
  });

  it('refuses to remove the LAST admin', async () => {
    const cookie = await adminSession();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/members/${adminUserId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
    });
    // 409 whether it is the last-admin rule or the self-removal rule that
    // catches it — both are STATE refusals of a well-formed request.
    expect(res.statusCode).toBe(409);
    const [still] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.id, adminUserId));
    expect(still, 'the refusal must not have partially applied').toBeDefined();
  });

  it('refuses to remove YOURSELF, even with another admin present', async () => {
    // Deleting your own account ends the session mid-request and leaves you
    // staring at a 401 from a screen you were just using. An admin who wants to
    // leave should be removed by another admin, which is also the audit trail
    // you want for it.
    const cookie = await adminSession();
    await db
      .update(core.workspaceMembers)
      .set({ role: 'admin' })
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          eq(core.workspaceMembers.userId, memberUserId),
        ),
      );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/members/${adminUserId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().title).toMatch(/your own account/i);

    // Put the role back. A test that promotes a shared fixture member and
    // leaves it promoted breaks the ones after it — which is exactly what this
    // one did before the restore was added.
    await db
      .update(core.workspaceMembers)
      .set({ role: 'member' })
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          eq(core.workspaceMembers.userId, memberUserId),
        ),
      );
  });

  it('a member cannot reach the admin surface', async () => {
    const cookie = await loginAs(app, 'w4-20-member');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/members',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists dead-letter jobs WITH their error, and replays one', async () => {
    const cookie = await adminSession();
    const [failure] = await db
      .insert(core.jobFailure)
      .values({
        workspaceId,
        queue: 'ingest.backfill',
        jobId: 'bf-99-commits',
        payload: { workspaceId, repoId: 99, entityType: 'commits' },
        error: 'ForgeSsrfError: scheme must be https, got http:',
      })
      .returning();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dlq',
      cookies: { repopulse_sid: cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: { id: number; error: string }[] };
    const mine = body.items.find((i) => i.id === failure!.id);
    // The error is the point of the screen — a count with no reason is useless.
    expect(mine?.error).toContain('ForgeSsrfError');

    added.length = 0;
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/dlq/${failure!.id}/replay`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
    });
    expect(replay.statusCode).toBe(200);
    expect(added, 'replay must actually re-enqueue, not just mark the row').toHaveLength(1);
    expect(added[0]).toMatchObject({ name: 'bf-99-commits' });

    const [after] = await db
      .select({ replayedAt: core.jobFailure.replayedAt })
      .from(core.jobFailure)
      .where(eq(core.jobFailure.id, failure!.id));
    expect(after!.replayedAt).not.toBeNull();

    // Replayed rows drop out of the default list, so the queue shows OUTSTANDING
    // failures rather than a growing history nobody can clear.
    const after2 = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dlq',
      cookies: { repopulse_sid: cookie },
    });
    expect((after2.json() as { items: { id: number }[] }).items.map((i) => i.id)).not.toContain(
      failure!.id,
    );
  });

  // SC-22 audit entries (W12-09). W4-20 shipped these routes with no audit
  // line at all, though SECURITY_CONTROLS.md SC-22 names "admin role change"
  // in its own list of audited event classes.
  it('audit-logs a role change with the role it changed FROM', async () => {
    const cookie = await adminSession();
    await db
      .update(core.workspaceMembers)
      .set({ role: 'member' })
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          eq(core.workspaceMembers.userId, memberUserId),
        ),
      );

    audit.reset();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${memberUserId}`,
      cookies: { repopulse_sid: cookie },
      headers: { ...CSRF, 'user-agent': 'w12-09-audit' },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);

    const entry = audit.lines().find((l) => l.event === 'admin.role.changed');
    expect(entry, 'the role change must leave an audit entry').toBeTruthy();
    expect(entry).toMatchObject({
      event: 'admin.role.changed',
      actorUserId: adminUserId,
      targetUserId: memberUserId,
      // Without the OLD role the entry cannot be read as a privilege
      // escalation, which is the only reason T-29 wants it.
      fromRole: 'member',
      toRole: 'admin',
      ua: 'w12-09-audit',
    });
  });

  it('does NOT log a role change that was refused', async () => {
    const cookie = await adminSession();
    // Demote every other admin so the caller is the last one, then have them
    // demote themselves: the route 409s and nothing changes.
    await db
      .update(core.workspaceMembers)
      .set({ role: 'member' })
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          eq(core.workspaceMembers.userId, memberUserId),
        ),
      );

    audit.reset();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${adminUserId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { role: 'member' },
    });
    expect(res.statusCode).toBe(409);
    // An audit stream that records attempts as though they were changes is
    // worse than one that records neither — it would show a demotion that
    // never happened.
    expect(audit.lines().find((l) => l.event === 'admin.role.changed')).toBeUndefined();
  });

  it('audit-logs a DLQ replay, naming the queue and the actor', async () => {
    const cookie = await adminSession();
    const [failure] = await db
      .insert(core.jobFailure)
      .values({
        workspaceId,
        queue: 'ingest.backfill',
        jobId: 'w12-09-replay-audit',
        payload: { workspaceId, repoId: 7 },
        error: 'boom',
      })
      .returning();

    audit.reset();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/dlq/${failure!.id}/replay`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
    });
    expect(res.statusCode).toBe(200);

    // Not on the SC-22 list; logged anyway. Replay re-runs forge work on an
    // operator's say-so and the job_failure row records only THAT it was
    // replayed, never by whom.
    expect(audit.lines().find((l) => l.event === 'dlq.job.replayed')).toMatchObject({
      actorUserId: adminUserId,
      failureId: failure!.id,
      queue: 'ingest.backfill',
    });
  });

  it('another workspace’s dead-letter job is a 404, not a 403 (Law 5)', async () => {
    const cookie = await adminSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/dlq/${otherFailureId}/replay`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
    });
    // A 403 would confirm the id exists in some other tenant.
    expect(res.statusCode).toBe(404);
    expect(added.find((a) => a.name === 'other-tenant-job')).toBeUndefined();
  });
});
