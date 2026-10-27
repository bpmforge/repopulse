import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';

const CSRF = { 'x-requested-with': 'repopulse' };
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

// The in-app inbox (W20-10, UX_TODO X-03): new high/critical, KEV and secrets
// findings and failed scans since this user last looked.
describeIfLiveInfra('GET /me/inbox (W20-10)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let otherWorkspaceId: number;
  let repoId: number;
  let otherRepoId: number;
  let cookie: string;
  const scanRunIds: number[] = [];
  let seq = 0;

  async function connectionRepo(ws: number, tag: string): Promise<number> {
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId: ws,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: `w20-10-inbox-${tag}`,
        status: 'active',
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: ws,
        connectionId: conn!.id,
        forgeRepoId: `w20-10-inbox-${tag}`,
        org: 'acme',
        name: `inbox-${tag}`,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    return repo!.id;
  }

  async function scanRun(ws: number, repo: number, status: string, error?: string) {
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId: ws,
        repoId: repo,
        scannerKey: 'semgrep',
        scannerVersion: '1',
        commitSha: 'abc',
        trigger: 'manual',
        status,
        error: error ?? null,
      })
      .returning();
    scanRunIds.push(run!.id);
    return run!.id;
  }

  async function finding(
    ws: number,
    repo: number,
    v: { severity: number; dimension?: string; kev?: boolean; status?: string; title: string },
  ) {
    const run = await scanRun(ws, repo, 'succeeded');
    await db.insert(read.findings).values({
      scanRunId: run,
      workspaceId: ws,
      repoId: repo,
      dimension: v.dimension ?? 'sast',
      severity: v.severity,
      confidence: 3,
      title: v.title,
      evidence: 'x',
      recommendation: 'y',
      tier: 1,
      dedupKey: `w20-10-inbox-${seq++}`,
      status: v.status ?? 'open',
      ...(v.kev ? { yields: { kev: 'true' } } : {}),
    });
  }

  beforeAll(async () => {
    githubMock = createServer((req, res) => {
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
    const gh = `http://127.0.0.1:${addr.port}`;
    app = buildApp({
      db,
      tokenKey: Buffer.alloc(32),
      webhookUrl: 'http://localhost/hook',
      redisUrl: redisUrl as string,
      sessionSecret: 'w20-10-inbox-session-secret-long-enough-here',
      idleTimeoutMs: 60_000,
      absoluteLifetimeMs: 600_000,
      cookieSecure: false,
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: { tokenUrl: `${gh}/login/oauth/access_token`, userUrl: `${gh}/user` },
      loginRedirectUrl: 'http://localhost/',
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
      .values({ slug: 'w20-10-inbox-other', name: 'Other' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Other' } })
      .returning();
    otherWorkspaceId = other!.id;
    repoId = await connectionRepo(workspaceId, 'mine');
    otherRepoId = await connectionRepo(otherWorkspaceId, 'theirs');

    cookie = await loginAs(app, 'w20-10-inbox-user');
    const [u] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, 'w20-10-inbox-user'));
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: u!.id, role: 'member' })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(read.findings).where(inArray(read.findings.repoId, [repoId, otherRepoId]));
    await db.delete(security.scanRuns).where(inArray(security.scanRuns.id, scanRunIds));
    await db.delete(core.repos).where(inArray(core.repos.id, [repoId, otherRepoId]));
    await db
      .delete(core.forgeConnections)
      .where(
        inArray(core.forgeConnections.credentialFingerprint, [
          'w20-10-inbox-mine',
          'w20-10-inbox-theirs',
        ]),
      );
    await db.delete(core.workspaces).where(eq(core.workspaces.id, otherWorkspaceId));
    const [u] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, 'w20-10-inbox-user'));
    if (u) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, u.id));
      await db.delete(core.users).where(eq(core.users.id, u.id));
    }
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
    await db.$client.end();
  });

  const inbox = () =>
    app.inject({ method: 'GET', url: '/api/v1/me/inbox', cookies: { repopulse_sid: cookie } });

  it('lists what is new and serious, and nothing else', async () => {
    await finding(workspaceId, repoId, { severity: 5, title: 'w20-10 critical' });
    await finding(workspaceId, repoId, {
      severity: 2,
      dimension: 'secrets',
      title: 'w20-10 secret',
    });
    await finding(workspaceId, repoId, { severity: 2, kev: true, title: 'w20-10 kev' });
    await finding(workspaceId, repoId, { severity: 2, title: 'w20-10 low' });
    await finding(workspaceId, repoId, {
      severity: 5,
      status: 'dismissed',
      title: 'w20-10 dismissed',
    });
    await finding(otherWorkspaceId, otherRepoId, { severity: 5, title: 'w20-10 other tenant' });
    await scanRun(workspaceId, repoId, 'failed', 'semgrep crashed\nstack…');

    const res = await inbox();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.first_look).toBe(true);
    const titles = body.findings.map((f: { title: string }) => f.title);
    expect(titles).toEqual(
      expect.arrayContaining(['w20-10 critical', 'w20-10 secret', 'w20-10 kev']),
    );
    for (const absent of ['w20-10 low', 'w20-10 dismissed', 'w20-10 other tenant']) {
      expect(titles).not.toContain(absent);
    }
    expect(body.findings.find((f: { title: string }) => f.title === 'w20-10 kev').kev).toBe(true);
    const scan = body.failed_scans.find((s: { repo_id: number }) => s.repo_id === repoId);
    expect(scan.error).toBe('semgrep crashed');
    expect(body.unread).toBe(body.findings_count + body.failed_scans_count);
  });

  it('"mark all as seen" clears the count; something newer brings it back', async () => {
    const seen = await app.inject({
      method: 'POST',
      url: '/api/v1/me/inbox/seen',
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
    });
    expect(seen.statusCode).toBe(200);
    const after = (await inbox()).json();
    expect(after.first_look).toBe(false);
    expect(after.findings.map((f: { title: string }) => f.title)).not.toContain('w20-10 critical');

    await new Promise((r) => setTimeout(r, 5));
    await finding(workspaceId, repoId, { severity: 4, title: 'w20-10 newer high' });
    const later = (await inbox()).json();
    expect(later.findings.map((f: { title: string }) => f.title)).toContain('w20-10 newer high');
  });

  it("a Node clock ahead of the database's does not hide a newer finding", async () => {
    // The inbox compares findings.first_seen_at (stamped by Postgres) with the
    // user's inboxSeenAt. When the API took inboxSeenAt from its own clock, a
    // database clock behind it by more than the gap between "seen" and the next
    // finding hid that finding: the test above flaked whenever the podman VM's
    // clock lagged the host by over 5 ms, and in a deployment the API and the
    // database are separate machines. The API's clock is 30 s fast here (inside
    // this app's 60 s idle timeout, which also reads the clock).
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + 30_000);
    try {
      const seen = await app.inject({
        method: 'POST',
        url: '/api/v1/me/inbox/seen',
        headers: CSRF,
        cookies: { repopulse_sid: cookie },
      });
      expect(seen.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    await new Promise((r) => setTimeout(r, 5));
    await finding(workspaceId, repoId, { severity: 4, title: 'w20-10 newer than a fast clock' });
    const later = (await inbox()).json();
    expect(later.findings.map((f: { title: string }) => f.title)).toContain(
      'w20-10 newer than a fast clock',
    );
  });

  it('is for signed-in users only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me/inbox' });
    expect(res.statusCode).toBe(401);
  });
});
