import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, type Database } from '@repopulse/shared';
import type { Job, Queue } from 'bullmq';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

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
      .values({ forgeUserId: 'w4-20-member', login: 'w4-20-member' })
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
      payload: { role: 'superuser' },
    });
    // The DB CHECK would also reject it, but a 500 from a constraint is not an
    // answer an operator can act on.
    expect(res.statusCode).toBe(400);
  });

  it('refuses to demote the LAST admin — that would lock the workspace out', async () => {
    const cookie = await adminSession();
    // Make the caller the only admin.
    await db
      .update(core.workspaceMembers)
      .set({ role: 'member' })
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspaceId),
          eq(core.workspaceMembers.userId, memberUserId),
        ),
      );

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/members/${adminUserId}`,
      cookies: { repopulse_sid: cookie },
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

  it('another workspace’s dead-letter job is a 404, not a 403 (Law 5)', async () => {
    const cookie = await adminSession();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/dlq/${otherFailureId}/replay`,
      cookies: { repopulse_sid: cookie },
    });
    // A 403 would confirm the id exists in some other tenant.
    expect(res.statusCode).toBe(404);
    expect(added.find((a) => a.name === 'other-tenant-job')).toBeUndefined();
  });
});
