import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';

// Review actions, against a real Postgres (W17-23).
//
// What the panel shows after a click is the LIST re-read from the database, so
// "the transition persisted" is a claim about rows, not about React state. A
// stubbed db would prove the route's opinion of itself; these prove that a
// valid transition survives a reload (GET by id after PATCH), that an invalid
// one leaves the row exactly where it was, and that every applied transition
// carries a history row naming who did it and why.

const CSRF = { 'x-requested-with': 'repopulse' };
const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const TRIAGER = 'w17-23-triager';

describeIfLiveInfra('finding transitions persist and invalid ones are refused (W17-23)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let repoId: number;
  let connectionId: number;
  let scanRunId: number;
  let triagerUserId: number;
  let cookie: string;

  async function seedFinding(key: string, status = 'open'): Promise<number> {
    const [row] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        dimension: 'security',
        tier: 1,
        severity: 4,
        confidence: 4,
        title: `W17-23 ${key}`,
        file: 'src/pay.ts',
        lineStart: 10,
        lineEnd: 12,
        evidence: 'evidence',
        recommendation: 'fix it',
        dedupKey: `w17-23-${key}`,
        scanRunId,
        status,
        scannerKey: 'secrets',
      })
      .returning();
    return row!.id;
  }

  async function statusOf(id: number): Promise<string> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/findings/${id}`,
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { status: string }).status;
  }

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      if (req.url?.startsWith('/login/oauth/access_token')) {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString() || '{}';
          const code = (JSON.parse(body) as { code?: string }).code ?? 'tok';
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
      sessionSecret: 'w17-23-session-secret-that-is-long-enough-here',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: {
        tokenUrl: `${ghBase}/login/oauth/access_token`,
        userUrl: `${ghBase}/user`,
      },
      loginRedirectUrl: 'http://localhost/',
    });
    await app.ready();

    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [triager] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: TRIAGER,
        forgeUserId: TRIAGER,
        login: TRIAGER,
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: TRIAGER } })
      .returning();
    triagerUserId = triager!.id;
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: triagerUserId, role: 'member' })
      .onConflictDoUpdate({
        target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
        set: { role: 'member' },
      });

    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'w17-23-fp',
        status: 'active',
        createdBy: triagerUserId,
      })
      .returning();
    connectionId = conn!.id;

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w17-23-repo',
        org: 'repopulse',
        name: 'w17-23-review',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    const [scanRun] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'secrets',
        scannerVersion: 'test',
        commitSha: 'w17-23-sha',
        trigger: 'manual',
        status: 'succeeded',
        validationFunnel: { raw: 1, deduped: 1 },
      })
      .returning();
    scanRunId = scanRun!.id;

    cookie = await loginAs(app, TRIAGER);
  });

  afterAll(async () => {
    // Only THIS file's history: the dev database shares the default workspace.
    await db
      .delete(read.findingEvents)
      .where(
        inArray(
          read.findingEvents.findingId,
          db
            .select({ id: read.findings.id })
            .from(read.findings)
            .where(eq(read.findings.repoId, repoId)),
        ),
      );
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, triagerUserId));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
  });

  it('a valid transition persists and is read back by id, with actor and reason in history', async () => {
    const id = await seedFinding('valid');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/findings/${id}`,
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: { status: 'confirmed', note: 'Reproduced against staging.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'confirmed' });

    // "Through reload": a fresh read, not the mutation's own echo.
    expect(await statusOf(id)).toBe('confirmed');

    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/findings/${id}/history`,
      cookies: { repopulse_sid: cookie },
    });
    expect(history.statusCode).toBe(200);
    const items = (history.json() as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      from_status: 'open',
      to_status: 'confirmed',
      actor: triagerUserId,
      actor_login: TRIAGER,
      automatic: false,
      reason: 'Reproduced against staging.',
    });
  });

  it('a dismissal records the reason category with the note', async () => {
    const id = await seedFinding('dismiss');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/findings/${id}`,
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: { status: 'dismissed', note: 'Test fixture.', dismiss_reason: 'false_positive' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'dismissed', dismiss_reason: 'false_positive' });

    const [row] = await db.select().from(read.findings).where(eq(read.findings.id, id));
    expect(row?.status).toBe('dismissed');
    expect(row?.dismissReason).toBe('false_positive');
    expect(row?.statusChangedBy).toBe(triagerUserId);

    const [event] = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.findingId, id));
    expect(event?.reason).toBe('false_positive: Test fixture.');
    expect(event?.actorLogin).toBe(TRIAGER);
  });

  it('an invalid transition is a 409 and leaves the row and its history untouched', async () => {
    // resolved → confirmed is not in the lifecycle table: a person may only
    // reopen a resolved finding.
    const id = await seedFinding('invalid', 'resolved');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/findings/${id}`,
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: { status: 'confirmed', note: 'Should not apply.' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ title: 'Transition not allowed' });
    expect((res.json() as { detail: string }).detail).toMatch(/resolved → confirmed/);

    expect(await statusOf(id)).toBe('resolved');
    const events = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.findingId, id));
    expect(events).toHaveLength(0);
  });

  it('rejects a malformed request before touching the row', async () => {
    const id = await seedFinding('malformed');
    for (const payload of [
      { status: 'confirmed' },
      { status: 'confirmed', note: '   ' },
      { status: 'archived', note: 'x' },
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/findings/${id}`,
        headers: CSRF,
        cookies: { repopulse_sid: cookie },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await statusOf(id)).toBe('open');
  });

  it('bulk applies the valid rows, reports the rest, and writes one history row per applied', async () => {
    const a = await seedFinding('bulk-a');
    const b = await seedFinding('bulk-b');
    const c = await seedFinding('bulk-c', 'resolved');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/findings/bulk',
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: { ids: [a, b, c], status: 'confirmed', note: 'Weekly review.' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: number[]; skipped: { id: number; reason: string }[] };
    expect(body.applied.sort()).toEqual([a, b].sort());
    expect(body.skipped).toEqual([{ id: c, reason: 'resolved → confirmed not permitted' }]);

    expect(await statusOf(a)).toBe('confirmed');
    expect(await statusOf(b)).toBe('confirmed');
    expect(await statusOf(c)).toBe('resolved');

    for (const id of [a, b]) {
      const events = await db
        .select()
        .from(read.findingEvents)
        .where(eq(read.findingEvents.findingId, id));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: triagerUserId,
        actorLogin: TRIAGER,
        reason: 'Weekly review.',
      });
    }
  });

  // W20-03 (UX_TODO FND-11): the bulk bar offers every lifecycle move and a
  // dismiss reason. The route takes both, and still decides per row.
  it('bulk dismissal records the reason category on each row and in its history', async () => {
    const a = await seedFinding('bulk-reason-a');
    const b = await seedFinding('bulk-reason-b', 'dismissed');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/findings/bulk',
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: {
        ids: [a, b],
        status: 'dismissed',
        note: 'Vendored code.',
        dismiss_reason: 'not_applicable',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applied: number[]; skipped: { id: number; reason: string }[] };
    expect(body.applied).toEqual([a]);
    expect(body.skipped).toEqual([{ id: b, reason: 'dismissed → dismissed not permitted' }]);

    const [row] = await db.select().from(read.findings).where(eq(read.findings.id, a));
    expect(row?.status).toBe('dismissed');
    expect(row?.dismissReason).toBe('not_applicable');
    const [event] = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.findingId, a));
    expect(event?.reason).toBe('not_applicable: Vendored code.');
  });

  it('bulk refuses an unknown dismiss reason before touching any row', async () => {
    const a = await seedFinding('bulk-bad-reason');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/findings/bulk',
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: { ids: [a], status: 'dismissed', note: 'x', dismiss_reason: 'because' },
    });
    expect(res.statusCode).toBe(400);
    expect(await statusOf(a)).toBe('open');
  });

  it("bulk resolve, won't fix and reopen follow the lifecycle per row", async () => {
    const confirmed = await seedFinding('bulk-resolve-a', 'confirmed');
    const open = await seedFinding('bulk-resolve-b');
    const send = (ids: number[], status: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/findings/bulk',
        headers: CSRF,
        cookies: { repopulse_sid: cookie },
        payload: { ids, status, note: 'Sprint close.' },
      });

    // open → resolved is not a move a person makes; confirmed → resolved is.
    const resolved = (await send([confirmed, open], 'resolved')).json() as {
      applied: number[];
      skipped: { id: number; reason: string }[];
    };
    expect(resolved.applied).toEqual([confirmed]);
    expect(resolved.skipped).toEqual([{ id: open, reason: 'open → resolved not permitted' }]);

    expect((await send([open], 'wont_fix')).json()).toMatchObject({ applied: [open] });
    expect((await send([confirmed, open], 'open')).json()).toMatchObject({
      skipped: [],
    });
    expect(await statusOf(confirmed)).toBe('open');
    expect(await statusOf(open)).toBe('open');
  });

  it("bulk never touches another workspace's finding, and reports it as not found", async () => {
    const [other] = await db
      .insert(core.workspaces)
      .values({ slug: 'w20-03-other', name: 'Other' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Other' } })
      .returning();
    const [foreign] = await db
      .insert(read.findings)
      .values({
        workspaceId: other!.id,
        repoId,
        dimension: 'security',
        tier: 1,
        severity: 4,
        confidence: 4,
        title: 'W20-03 foreign',
        file: 'src/pay.ts',
        lineStart: 1,
        lineEnd: 1,
        evidence: 'e',
        recommendation: 'r',
        dedupKey: 'w20-03-foreign',
        scanRunId,
        scannerKey: 'secrets',
        status: 'open',
      })
      .returning();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/findings/bulk',
        headers: CSRF,
        cookies: { repopulse_sid: cookie },
        payload: {
          ids: [foreign!.id],
          status: 'dismissed',
          note: 'x',
          dismiss_reason: 'duplicate',
        },
      });
      expect(res.json()).toEqual({
        applied: [],
        skipped: [{ id: foreign!.id, reason: 'not found' }],
      });
      const [row] = await db.select().from(read.findings).where(eq(read.findings.id, foreign!.id));
      expect(row?.status).toBe('open');
    } finally {
      await db.delete(read.findings).where(eq(read.findings.id, foreign!.id));
      await db.delete(core.workspaces).where(eq(core.workspaces.id, other!.id));
    }
  });

  it('the list reports how many findings match across every page', async () => {
    await seedFinding('total-a');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/findings?repo_id=${repoId}&status=open`,
      cookies: { repopulse_sid: cookie },
    });
    const body = res.json() as { items: { status: string }[]; total: number };
    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.status, 'open')));
    expect(body.total).toBe(counted!.n);
    expect(body.total).toBeGreaterThan(0);
  });
});
