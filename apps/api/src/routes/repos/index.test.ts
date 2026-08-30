import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import authRoutes from '../auth/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import apiV1 from '../../plugins/api-v1.js';
import { loginAs } from '../../testing/login.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;
const FIXTURE = 'w4-01-user';
// RELATIVE TO NOW, quantised to UTC midnight (W16-45). This was pinned to
// 2026-07-10, which was recent when it was written and 51 days stale by the
// time the PR list started honouring the window (W16-44) — at which point the
// fixture's only PR fell outside the default 30d and this walk broke on a
// change that was correct. The seeder learned the same lesson in `anchorFor`:
// an absolute date in a fixture is a test that expires.
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS - 3 * DAY_MS);

describeIfLiveInfra('drill-down + /me API (W4-01, FR-API-5, FR-AUTH-6)', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db: Database = createDb(databaseUrl as string);
  let repoId: number;


  beforeAll(async () => {
    githubMock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/login/oauth/access_token') {
          const b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code: string };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: b.code }));
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
    });
    await new Promise<void>((r) => githubMock.listen(0, r));
    const addr = githubMock.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock bind failed');
    const base = `http://127.0.0.1:${addr.port}`;

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    await app.register(authRoutes, {
      db,
      githubOAuth: {
        clientId: 'x',
        clientSecret: 'y',
        redirectUri: 'http://localhost:3000/auth/callback',
      },
      githubEndpoints: { tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` },
      loginRedirectUrl: 'http://localhost:5173/',
      redisUrl: redisUrl as string,
      sessionSecret: 'test-session-secret-at-least-32-characters-long',
      idleTimeoutMs: 900000,
      absoluteLifetimeMs: 43200000,
      cookieSecure: false,
    });
    await app.register(
      async (instance) => {
        // apiV1 now mounts repos/prs/files/me itself (W4-02) — registering
        // them again here would double-declare the routes.
        await apiV1(instance, {
          db,
          redisUrl: redisUrl as string,
          tokenKey: Buffer.alloc(32, 7),
          webhookUrl: 'http://localhost/api/v1/webhooks/github',
          enqueueBackfillPlan: async () => {},
        });
      },
      { prefix: '/api/v1' },
    );
    await app.ready();

    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    const wsId = ws!.id;
    const [connUser] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w4-01-conn', forgeUserId: 'w4-01-conn', login: 'w4-01-conn' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w4-01-conn' } })
      .returning();
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId: wsId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'fp',
        status: 'active',
        createdBy: connUser!.id,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: wsId,
        connectionId: conn!.id,
        forgeRepoId: 'r-w401',
        org: 'acme',
        name: 'w401',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
        pushedAt: RECENT,
      })
      .returning();
    repoId = repo!.id;
    // The fixture user's forge identity (forge_user_id matches the login code).
    const [id] = await db
      .insert(core.identities)
      .values({
        workspaceId: wsId,
        provider: 'github',
        forgeLogin: FIXTURE,
        forgeUserId: FIXTURE,
        displayName: FIXTURE,
      })
      .returning();
    const identityId = id!.id;
    // A PR authored by the fixture user + a commit/file they touched.
    await db.insert(facts.pullRequests).values({
      workspaceId: wsId,
      repoId,
      number: 1,
      forgePrId: 'PR1',
      title: 'my pr',
      authorIdentityId: identityId,
      state: 'merged',
      isDraft: false,
      isBot: false,
      createdAt: RECENT,
      updatedAt: RECENT,
      mergedAt: RECENT,
      firstReviewAt: RECENT,
      baseRef: 'main',
      headSha: 'h1',
      additions: 10,
      deletions: 2,
      changedFiles: 1,
      lastActivityAt: RECENT,
    });
    const [c] = await db
      .insert(facts.commits)
      .values({
        workspaceId: wsId,
        repoId,
        sha: 'c1',
        authorIdentityId: identityId,
        committerIdentityId: identityId,
        authoredAt: RECENT,
        committedAt: RECENT,
        messageHead: 'x',
        isRevertHeuristic: false,
        isMerge: false,
      })
      .returning();
    await db.insert(facts.commitFiles).values({
      workspaceId: wsId,
      repoId,
      commitId: c!.id,
      path: 'src/a.ts',
      additions: 10,
      deletions: 2,
      status: 'modified',
    });
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      githubMock.close((e) => (e ? reject(e) : resolve())),
    );
    const [ws] = await db.select().from(core.workspaces).where(eq(core.workspaces.slug, 'default'));
    if (ws) {
      await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, ws.id));
      await db.delete(facts.commits).where(eq(facts.commits.workspaceId, ws.id));
      await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, ws.id));
      await db.delete(core.identities).where(eq(core.identities.workspaceId, ws.id));
      await db.delete(core.repos).where(eq(core.repos.workspaceId, ws.id));
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.workspaceId, ws.id));
    }
    for (const u of [FIXTURE, 'w4-01-conn']) {
      const [row] = await db.select().from(core.users).where(eq(core.users.forgeUserId, u));
      if (row) {
        await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, row.id));
        await db.delete(core.users).where(eq(core.users.id, row.id));
      }
    }
    await db.$client.end();
  });

  it('walks the drill-down chain via children links: /repos → detail → prs → pr detail → file', async () => {
    const cookie = await loginAs(app, FIXTURE);
    const g = (url: string) =>
      app.inject({ method: 'GET', url, cookies: { repopulse_sid: cookie } });

    const list = await g('/api/v1/repos');
    expect(list.statusCode).toBe(200);
    const repo = list.json().items.find((r: { id: number }) => r.id === repoId);
    expect(repo.links.self).toBe(`/api/v1/repos/${repoId}`);

    const detail = await g(repo.links.self);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().health).toHaveProperty('breakdown');

    const prs = await g(detail.json().links.prs);
    expect(prs.statusCode).toBe(200);
    const pr = prs.json().items[0];
    expect(pr).toMatchObject({ number: 1, size_bucket: 'S', review_covered: true });

    const prDetail = await g(pr.links.self);
    expect(prDetail.statusCode).toBe(200);
    expect(prDetail.json().number).toBe(1);

    const file = await g(`/api/v1/repos/${repoId}/files/src/a.ts`);
    expect(file.statusCode).toBe(200);
    expect(file.json().path).toBe('src/a.ts');
    expect(file.json().churn_series).toHaveLength(1);
    expect(file.json().owners[0]).toMatchObject({ login: FIXTURE });
  });

  it("/me/prs returns the logged-in fixture user's ground truth (identity map, FR-AUTH-6)", async () => {
    const cookie = await loginAs(app, FIXTURE);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/prs',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { number: number }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.number).toBe(1);

    // /me/hotspots resolves files the user touched; /me/stats their merged count.
    const hot = await app.inject({
      method: 'GET',
      url: '/api/v1/me/hotspots',
      cookies: { repopulse_sid: cookie },
    });
    expect(hot.json().items[0]).toMatchObject({ path: 'src/a.ts' });
    const stats = await app.inject({
      method: 'GET',
      url: '/api/v1/me/stats',
      cookies: { repopulse_sid: cookie },
    });
    expect(stats.json().merged_prs).toBe(1);
  });

  it('a foreign repo id → 404 (tenancy, Law 5)', async () => {
    const cookie = await loginAs(app, FIXTURE);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/repos/999999999',
      cookies: { repopulse_sid: cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
