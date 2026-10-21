import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, setAuditSink, type AuditRecord, type Database } from '@repopulse/shared';
import type { ForgeProvider, ForgeRepo, GitHubAuth } from '@repopulse/forge';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import authRoutes from '../auth/index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import apiV1 from '../../plugins/api-v1.js';
import { loginAs } from '../../testing/login.js';
import { KEPT_REPO_TABLES, PURGED_REPO_TABLES } from '../../lib/purge-repo.js';
import { readWorkspaceSettings } from '../../lib/workspace-settings.js';

// W20-19 (decisions 2026-10-20), against real rows:
//  - INS-09: an admin removes a repository and purges its stored history,
//    behind a typed confirmation; its webhook goes via deleteWebhooks; another
//    repository's rows and another workspace's rows survive;
//  - INS-69: "scheduled sync only" per connection registers no hooks, and
//    switching it on removes the ones there; off registers them again.

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const CSRF = { 'x-requested-with': 'repopulse' };
const ADMIN = 'w20-19-purge-admin';
const MEMBER = 'w20-19-purge-member';
// Not a real token shape: never commit anything that looks like one.
const TOKEN = 'w2019-fake-credential-for-route-tests';

const REPOS: ForgeRepo[] = ['alpha', 'beta', 'gamma', 'delta'].map((name, i) => ({
  externalId: String(1901 + i),
  name,
  fullName: `w2019/${name}`,
  defaultBranch: 'main',
  isPrivate: true,
  isArchived: false,
  pushedAt: null,
  htmlUrl: '',
}));

const registerWebhook = vi.fn(
  (_ctx: unknown, _repo: string, _url: string, _secret: string, _events: string[]) =>
    Promise.resolve('hook-1'),
);
const deleteWebhooks = vi.fn((_ctx: unknown, _repo: string, _url: string) => Promise.resolve(1));
function fakeProvider(_auth: GitHubAuth, kind?: 'github' | 'gitea' | 'gitlab'): ForgeProvider {
  return {
    listRepos: () => Promise.resolve({ items: REPOS }),
    registerWebhook,
    deleteWebhooks,
    capabilities: { webhookScheme: kind === 'gitlab' ? 'gitlab-token' : 'hub-signature' },
  } as unknown as ForgeProvider;
}

/** Tables holding rows keyed by repo_id that the fixture writes. */
const FIXTURE_TABLES = [
  'commits',
  'pull_requests',
  'scan_runs',
  'findings',
  'metric_snapshots',
  'sync_cursors',
  'file_intents',
] as const;

describeIfLiveInfra('W20-19 repository purge and scheduled sync only', () => {
  let githubMock: Server;
  let app: FastifyInstance;
  const db: Database = createDb(databaseUrl as string);
  const sql = db.$client;
  const tokenKey = randomBytes(32);
  const audits: AuditRecord[] = [];
  let ws: number;
  let otherWs: number;
  let connId: number;
  let otherConnId: number;
  let otherRepoId: number;
  let identityId: number;
  let otherIdentityId: number;
  let adminCookie: string;
  const repoIds: Record<string, number> = {};

  async function seedHistory(workspaceId: number, repoId: number, identity: number, tag: string) {
    await sql`insert into commits (workspace_id, repo_id, sha, author_identity_id, committer_identity_id,
      authored_at, committed_at, message_head, is_revert_heuristic)
      values (${workspaceId}, ${repoId}, ${'sha-' + tag}, ${identity}, ${identity}, now(), now(), 'm', false)`;
    await sql`insert into pull_requests (workspace_id, repo_id, number, forge_pr_id, title, author_identity_id,
      state, is_draft, is_bot, created_at, updated_at, base_ref, head_sha, additions, deletions, changed_files)
      values (${workspaceId}, ${repoId}, 1, ${'pr-' + tag}, 't', ${identity}, 'open', false, false,
      now(), now(), 'main', 'h', 1, 1, 1)`;
    const [run] =
      await sql`insert into scan_runs (workspace_id, repo_id, scanner_key, scanner_version,
      commit_sha, trigger, status) values (${workspaceId}, ${repoId}, 'gitleaks', '1', 'h', 'manual', 'succeeded')
      returning id`;
    const [finding] = await sql`insert into findings (workspace_id, repo_id, scan_run_id, dimension,
      severity, confidence, title, evidence, recommendation, tier, dedup_key, status)
      values (${workspaceId}, ${repoId}, ${run!.id}, 'secrets', 3, 3, 't', 'e', 'r', 1, ${'dk-' + tag}, 'open')
      returning id`;
    await sql`insert into finding_events (workspace_id, finding_id, to_status)
      values (${workspaceId}, ${finding!.id}, 'open')`;
    await sql`insert into metric_snapshots (workspace_id, repo_id, metric_key, "window", value)
      values (${workspaceId}, ${repoId}, 'M1', '30d', 1)`;
    await sql`insert into sync_cursors (workspace_id, repo_id, entity_type)
      values (${workspaceId}, ${repoId}, 'commits')`;
    await sql`insert into file_intents (workspace_id, repo_id, path, intent)
      values (${workspaceId}, ${repoId}, 'a.ts', 'refactor')`;
  }

  async function rowCounts(repoId: number): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of FIXTURE_TABLES) {
      const [row] =
        await sql`select count(*)::int as n from ${sql(table)} where repo_id = ${repoId}`;
      out[table] = row!.n as number;
    }
    return out;
  }

  const purge = (repoId: number, confirm: string, cookie = adminCookie) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/repos/${repoId}`,
      cookies: { repopulse_sid: cookie },
      headers: CSRF,
      payload: { confirm },
    });

  beforeAll(async () => {
    setAuditSink((r) => audits.push(r));
    githubMock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/login/oauth/access_token') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code: string };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: body.code }));
          return;
        }
        if (req.url === '/user') {
          const login = (req.headers.authorization ?? '').replace('Bearer ', '');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: login, login, name: null, avatar_url: null }));
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
      githubOAuth: { clientId: 'x', clientSecret: 'y', redirectUri: 'http://localhost/cb' },
      githubEndpoints: { tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` },
      loginRedirectUrl: 'http://localhost:5173/',
      redisUrl: redisUrl as string,
      sessionSecret: 'w20-19-session-secret-at-least-32-characters',
      idleTimeoutMs: 15 * 60 * 1000,
      absoluteLifetimeMs: 12 * 60 * 60 * 1000,
      cookieSecure: false,
    });
    await app.register(
      async (instance) => {
        await apiV1(instance, {
          db,
          redisUrl: redisUrl as string,
          tokenKey,
          webhookUrl: 'https://repopulse.example/api/v1/webhooks/github',
          enqueueBackfillPlan: async () => {},
          buildProvider: fakeProvider,
        });
      },
      { prefix: '/api/v1' },
    );
    await app.ready();

    const [w] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    ws = w!.id;
    const [o] = await db
      .insert(core.workspaces)
      .values({ slug: 'w20-19-other', name: 'Other' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Other' } })
      .returning();
    otherWs = o!.id;
    for (const [login, role] of [
      [ADMIN, 'admin'],
      [MEMBER, 'member'],
    ] as const) {
      const [u] = await db
        .insert(core.users)
        .values({ authProvider: 'github', authSubject: login, forgeUserId: login, login })
        .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login } })
        .returning();
      await db
        .insert(core.workspaceMembers)
        .values({ workspaceId: ws, userId: u!.id, role })
        .onConflictDoUpdate({
          target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
          set: { role },
        });
    }
    adminCookie = await loginAs(app, ADMIN);

    // The connection, made the way an admin makes it, then every repo tracked.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
      payload: { provider: 'github', auth_kind: 'pat', credential: TOKEN },
    });
    expect(created.statusCode).toBe(201);
    connId = (created.json() as { id: number }).id;
    const tracked = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
      payload: { repo_forge_ids: REPOS.map((r) => r.externalId) },
    });
    expect(tracked.statusCode).toBe(200);
    const rows = await db.select().from(core.repos).where(eq(core.repos.connectionId, connId));
    for (const r of rows) repoIds[r.name] = r.id;

    const [ident] =
      await sql`insert into identities (workspace_id, provider, forge_login, display_name)
      values (${ws}, 'github', 'w2019-dev', 'Dev') on conflict (workspace_id, provider, forge_login)
      do update set display_name = 'Dev' returning id`;
    identityId = ident!.id as number;
    const [otherIdent] =
      await sql`insert into identities (workspace_id, provider, forge_login, display_name)
      values (${otherWs}, 'github', 'w2019-dev', 'Dev') on conflict (workspace_id, provider, forge_login)
      do update set display_name = 'Dev' returning id`;
    otherIdentityId = otherIdent!.id as number;

    // Another workspace with a repository of the SAME org/name.
    const [oc] = await sql`insert into forge_connections (workspace_id, provider, auth_kind,
      credential_ciphertext, credential_iv, key_version, credential_fingerprint, status)
      values (${otherWs}, 'github', 'pat', ${Buffer.alloc(1)}, ${Buffer.alloc(1)}, 1, 'w2019-other', 'active')
      returning id`;
    otherConnId = oc!.id as number;
    const [or] = await sql`insert into repos (workspace_id, connection_id, forge_repo_id, org, name,
      default_branch, is_private, is_archived, sync_status, tier2_auto)
      values (${otherWs}, ${otherConnId}, '1901', 'w2019', 'alpha', 'main', true, false, 'live', false)
      returning id`;
    otherRepoId = or!.id as number;

    await seedHistory(ws, repoIds.alpha!, identityId, 'alpha');
    await seedHistory(ws, repoIds.beta!, identityId, 'beta');
    await seedHistory(otherWs, otherRepoId, otherIdentityId, 'other');
  });

  beforeEach(() => {
    audits.length = 0;
    registerWebhook.mockClear();
    deleteWebhooks.mockClear();
  });

  afterAll(async () => {
    setAuditSink(undefined);
    await app.close();
    await new Promise<void>((resolve) => githubMock.close(() => resolve()));
    for (const [workspaceId, ids] of [
      [ws, Object.values(repoIds)],
      [otherWs, [otherRepoId]],
    ] as const) {
      for (const id of ids) {
        await sql`delete from finding_events where finding_id in (select id from findings where repo_id = ${id})`;
        for (const t of [
          'findings',
          'scan_runs',
          'commits',
          'pull_requests',
          'metric_snapshots',
          'sync_cursors',
          'file_intents',
          'egress_audit',
        ]) {
          await sql`delete from ${sql(t)} where repo_id = ${id} and workspace_id = ${workspaceId}`;
        }
      }
      await sql`delete from agreements where workspace_id = ${workspaceId} and kind = 'pr_size_max' and threshold = ${JSON.stringify({ lines: 1919 })}::jsonb`;
      await sql`delete from ci_tokens where workspace_id = ${workspaceId} and name like 'w2019-%'`;
      await sql`delete from plan_items where workspace_id = ${workspaceId} and catalog_id = 'w2019'`;
      await sql`delete from improvement_plans where workspace_id = ${workspaceId} and catalog_version = 'w2019'`;
      await sql`delete from identities where workspace_id = ${workspaceId} and forge_login = 'w2019-dev'`;
      await sql`delete from repos where workspace_id = ${workspaceId} and org = 'w2019'`;
    }
    // The purge test leaves beta's cached response behind on purpose.
    await sql`delete from forge_etag where workspace_id = ${ws} and endpoint_key like 'w2022-%'`;
    await sql`delete from forge_connections where workspace_id = ${otherWs}`;
    for (const credential of [TOKEN, `${TOKEN}-2`]) {
      await sql`delete from forge_connections where workspace_id = ${ws}
        and credential_fingerprint = ${credentials.credentialFingerprint(credential)}`;
    }
    // The settings keys this file wrote, so the default workspace is as found.
    await sql`update workspaces set settings = settings - 'auto_add_skip'
      - 'scheduled_sync_only_connection_ids' where id = ${ws}`;
    await sql`delete from workspaces where id = ${otherWs}`;
    for (const login of [ADMIN, MEMBER]) {
      const [u] = await db.select().from(core.users).where(eq(core.users.forgeUserId, login));
      if (u) {
        await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, u.id));
        await db.delete(core.users).where(eq(core.users.id, u.id));
      }
    }
    await db.$client.end();
  });

  it('handles every table with a repo_id or repo_ids column (a new one fails here)', async () => {
    const rows = await sql`select distinct c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and c.column_name in ('repo_id', 'repo_ids')`;
    const inDb = rows.map((r) => r.table_name as string).sort();
    const handled = [...PURGED_REPO_TABLES, ...KEPT_REPO_TABLES].sort();
    expect(inDb).toEqual(handled);
  });

  it('refuses a member, a wrong confirmation, and another workspace’s repository', async () => {
    const memberCookie = await loginAs(app, MEMBER);
    expect((await purge(repoIds.alpha!, 'w2019/alpha', memberCookie)).statusCode).toBe(403);
    const wrong = await purge(repoIds.alpha!, 'w2019/alpah');
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { detail: string }).detail).toContain('w2019/alpha');
    // Law 5: the other workspace's repository is a 404 even typed correctly.
    expect((await purge(otherRepoId, 'w2019/alpha')).statusCode).toBe(404);
    expect(deleteWebhooks).not.toHaveBeenCalled();
    expect((await rowCounts(repoIds.alpha!)).commits).toBe(1);
  });

  it('purges one repository: its rows, its hook and its single-repo lists; the rest survive', async () => {
    const a = repoIds.alpha!;
    const b = repoIds.beta!;
    const [plan1] =
      await sql`insert into improvement_plans (workspace_id, repo_ids, "window", catalog_version)
      values (${ws}, ${[a]}, '30d', 'w2019') returning id`;
    await sql`insert into plan_items (workspace_id, plan_id, rank, catalog_id, source, evidence,
      recommendation, effort, verify_criterion) values (${ws}, ${plan1!.id}, 1, 'w2019', 'metric',
      ${'{}'}::jsonb, 'r', 'S', ${'{}'}::jsonb)`;
    const [plan2] =
      await sql`insert into improvement_plans (workspace_id, repo_ids, "window", catalog_version)
      values (${ws}, ${[a, b]}, '30d', 'w2019') returning id`;
    const [agr1] = await sql`insert into agreements (workspace_id, repo_ids, kind, threshold)
      values (${ws}, ${[a]}, 'pr_size_max', ${JSON.stringify({ lines: 1919 })}::jsonb) returning id`;
    const [agr2] = await sql`insert into agreements (workspace_id, repo_ids, kind, threshold)
      values (${ws}, ${[a, b]}, 'pr_size_max', ${JSON.stringify({ lines: 1919 })}::jsonb) returning id`;
    const [tok1] =
      await sql`insert into ci_tokens (workspace_id, name, token_hash, token_prefix, repo_ids)
      values (${ws}, 'w2019-one', ${'h1-' + randomBytes(8).toString('hex')}, 'p1', ${[a]}) returning id`;
    const [tok2] =
      await sql`insert into ci_tokens (workspace_id, name, token_hash, token_prefix, repo_ids)
      values (${ws}, 'w2019-two', ${'h2-' + randomBytes(8).toString('hex')}, 'p2', ${[a, b]}) returning id`;

    // W20-22: cached forge responses about alpha go; beta's stay.
    await sql`insert into forge_etag (connection_id, workspace_id, endpoint_key, etag, cached_body)
      values (${connId}, ${ws}, 'w2022-alpha', 'e1', ${JSON.stringify({ full_name: 'w2019/alpha' })}::jsonb),
             (${connId}, ${ws}, 'w2022-beta', 'e2', ${JSON.stringify({ full_name: 'w2019/beta' })}::jsonb)`;

    const res = await purge(a, ' w2019/alpha ');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deleted: Record<string, number>;
      narrowed: Record<string, number>;
      ci_tokens_revoked: number;
      webhooks_removed: number;
    };
    expect(body.deleted).toMatchObject({
      commits: 1,
      pull_requests: 1,
      findings: 1,
      finding_events: 1,
      scan_runs: 1,
      metric_snapshots: 1,
      sync_cursors: 1,
      file_intents: 1,
      agreements: 1,
      improvement_plans: 1,
      plan_items: 1,
      forge_etag: 1,
      repos: 1,
    });
    const etagKeys = await sql`select endpoint_key from forge_etag where workspace_id = ${ws}
      and endpoint_key like 'w2022-%'`;
    expect(etagKeys.map((r) => r.endpoint_key)).toEqual(['w2022-beta']);
    expect(body.narrowed).toMatchObject({ agreements: 1, improvement_plans: 1, ci_tokens: 1 });
    expect(body.ci_tokens_revoked).toBe(1);
    expect(body.webhooks_removed).toBe(1);
    // The hook goes through the existing deleteWebhooks path, by delivery URL.
    expect(deleteWebhooks).toHaveBeenCalledTimes(1);
    expect(deleteWebhooks.mock.calls[0]![1]).toBe('w2019/alpha');
    expect(deleteWebhooks.mock.calls[0]![2]).toBe(
      'https://repopulse.example/api/v1/webhooks/github',
    );

    // Gone: the repository and everything about it.
    expect(await db.select().from(core.repos).where(eq(core.repos.id, a))).toHaveLength(0);
    expect(Object.values(await rowCounts(a)).every((n) => n === 0)).toBe(true);
    // Survive: the other repository in this workspace, and the other workspace.
    expect(await rowCounts(b)).toEqual(Object.fromEntries(FIXTURE_TABLES.map((t) => [t, 1])));
    expect(await rowCounts(otherRepoId)).toEqual(
      Object.fromEntries(FIXTURE_TABLES.map((t) => [t, 1])),
    );
    // Lists: never widened to "every repository".
    const [p1] =
      await sql`select count(*)::int as n from improvement_plans where id = ${plan1!.id}`;
    expect(p1!.n).toBe(0);
    const [p2] = await sql`select repo_ids from improvement_plans where id = ${plan2!.id}`;
    expect((p2!.repo_ids as string[]).map(Number)).toEqual([b]);
    const [a1] = await sql`select count(*)::int as n from agreements where id = ${agr1!.id}`;
    expect(a1!.n).toBe(0);
    const [a2] = await sql`select repo_ids from agreements where id = ${agr2!.id}`;
    expect((a2!.repo_ids as string[]).map(Number)).toEqual([b]);
    const [t1] = await sql`select revoked_at from ci_tokens where id = ${tok1!.id}`;
    expect(t1!.revoked_at).not.toBeNull();
    const [t2] = await sql`select repo_ids, revoked_at from ci_tokens where id = ${tok2!.id}`;
    expect((t2!.repo_ids as string[]).map(Number)).toEqual([b]);
    expect(t2!.revoked_at).toBeNull();

    // Audited, by name, because no row is left to resolve the id with.
    const entry = audits.find((e) => e.event === 'repo.purged');
    expect(entry).toMatchObject({ workspaceId: ws, repoId: a, repo: 'w2019/alpha' });
  });

  it('refuses a repository whose code was sent off-network (append-only egress record)', async () => {
    const g = repoIds.gamma!;
    await sql`insert into egress_audit (workspace_id, repo_id, model_id, bytes_sent, content_sha256)
      values (${ws}, ${g}, 'hosted-model', 10, 'abc')`;
    const res = await purge(g, 'w2019/gamma');
    expect(res.statusCode).toBe(409);
    expect(await db.select().from(core.repos).where(eq(core.repos.id, g))).toHaveLength(1);
    expect(deleteWebhooks).not.toHaveBeenCalled();
  });

  it('a purged repository is not auto-added again by the nightly sweep', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/connections/${connId}/auto-add`,
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
      payload: { enabled: true },
    });
    const res = await purge(repoIds.delta!, 'w2019/delta');
    expect(res.statusCode).toBe(200);
    const { stored } = await readWorkspaceSettings(db, ws);
    expect(stored.auto_add_skip?.[String(connId)]).toContain('1904');
    await app.inject({
      method: 'PUT',
      url: `/api/v1/connections/${connId}/auto-add`,
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
      payload: { enabled: false },
    });
  });

  it('scheduled sync only: on removes hooks and tracks without one; off registers them again', async () => {
    const put = (enabled: boolean) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/connections/${connId}/scheduled-sync`,
        cookies: { repopulse_sid: adminCookie },
        headers: CSRF,
        payload: { enabled },
      });

    const on = await put(true);
    expect(on.statusCode).toBe(200);
    // Beta and gamma remain on the connection (alpha and delta were purged).
    expect(on.json()).toMatchObject({ scheduled_sync_only: true, webhooks_removed: 2 });
    expect(deleteWebhooks).toHaveBeenCalledTimes(2);
    expect(audits.find((e) => e.event === 'connection.scheduled_sync_only')).toMatchObject({
      enabled: true,
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: adminCookie },
    });
    const row = (
      list.json() as { items: { id: number; scheduled_sync_only: boolean }[] }
    ).items.find((c) => c.id === connId);
    expect(row?.scheduled_sync_only).toBe(true);

    // Tracking again registers no hook while it is on.
    const track = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/repos`,
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
      payload: { repo_forge_ids: ['1901'] },
    });
    expect(track.statusCode).toBe(200);
    expect((track.json() as { repo_ids: number[] }).repo_ids).toHaveLength(1);
    expect(registerWebhook).not.toHaveBeenCalled();
    const [again] = await db
      .select()
      .from(core.repos)
      .where(eq(core.repos.id, (track.json() as { repo_ids: number[] }).repo_ids[0]!));
    repoIds.alpha = again!.id;
    expect(again!.lastError).toBeNull();

    // Re-registering by hand is refused with the reason.
    const rehook = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${connId}/webhooks`,
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
    });
    expect(rehook.statusCode).toBe(409);

    const off = await put(false);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ scheduled_sync_only: false, webhooks_registered: 3 });
    expect(registerWebhook).toHaveBeenCalledTimes(3);
  });

  it('a connection can be created as scheduled sync only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
      payload: {
        provider: 'github',
        auth_kind: 'pat',
        credential: `${TOKEN}-2`,
        scheduled_sync_only: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: number; scheduled_sync_only: boolean }).id;
    expect(res.json()).toMatchObject({ scheduled_sync_only: true });
    const { stored } = await readWorkspaceSettings(db, ws);
    expect(stored.scheduled_sync_only_connection_ids).toContain(id);
    // Removing it drops the choice with it.
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/connections/${id}`,
      cookies: { repopulse_sid: adminCookie },
      headers: CSRF,
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await readWorkspaceSettings(db, ws)).stored.scheduled_sync_only_connection_ids,
    ).not.toContain(id);
  });
});
