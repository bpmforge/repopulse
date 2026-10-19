import 'dotenv/config';
import { createServer, type Server } from 'node:http';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, plans as plansSchema, read, type Database } from '@repopulse/shared';
import { buildApp } from '../../app.js';
import { loginAs } from '../../testing/login.js';

// One plan per scope, against a real Postgres (W17-24).
//
// The duplicate lived in the gap between two requests: nothing serialised
// generation, so a double-click — or a slow answer and a second press — wrote
// two plans with the same items, and the second re-proposed as `proposed` the
// items a person had just accepted in the first. The lock and the comparison
// are a database fact, so the tests are: concurrent POSTs land on ONE row,
// a repeat is answered with the same id, a different scope is a different
// plan whose recorded repo_ids are exactly what was asked, and no GET ever
// writes a plan.

const CSRF = { 'x-requested-with': 'repopulse' };
const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const PLANNER = 'w17-24-planner';
// A window nothing else in the dev database generates plans over, so the
// scope comparison here cannot collide with plans other suites leave behind.
const WINDOW = 'w17-24-window';

interface GenerateReply {
  id: number;
  item_count: number;
  reused: boolean;
  repo_ids: number[];
  window: string;
}

describeIfLiveInfra('one plan per scope (W17-24)', () => {
  const db: Database = createDb(databaseUrl as string);
  let app: ReturnType<typeof buildApp>;
  let githubMock: Server;
  let workspaceId: number;
  let repoId: number;
  let otherRepoId: number;
  let connectionId: number;
  let plannerUserId: number;
  let cookie: string;
  const snapshotIds: number[] = [];

  async function generate(body: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: body,
    });
    return { status: res.statusCode, body: res.json() as GenerateReply };
  }

  async function plansForScope(repoIds: number[]): Promise<{ id: number; repoIds: number[] }[]> {
    const rows = await db
      .select({
        id: plansSchema.improvementPlans.id,
        repoIds: plansSchema.improvementPlans.repoIds,
      })
      .from(plansSchema.improvementPlans)
      .where(eq(plansSchema.improvementPlans.window, WINDOW));
    return rows.filter((r) => r.repoIds.join(',') === repoIds.join(','));
  }

  async function countPlans(): Promise<number> {
    const rows = await db
      .select({ id: plansSchema.improvementPlans.id })
      .from(plansSchema.improvementPlans)
      .where(eq(plansSchema.improvementPlans.workspaceId, workspaceId));
    return rows.length;
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
      sessionSecret: 'w17-24-session-secret-that-is-long-enough-here',
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

    const [planner] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: PLANNER,
        forgeUserId: PLANNER,
        login: PLANNER,
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: PLANNER } })
      .returning();
    plannerUserId = planner!.id;
    await db
      .insert(core.workspaceMembers)
      .values({ workspaceId, userId: plannerUserId, role: 'member' })
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
        credentialFingerprint: 'w17-24-fp',
        status: 'active',
        createdBy: plannerUserId,
      })
      .returning();
    connectionId = conn!.id;

    const repos = await db
      .insert(core.repos)
      .values([
        {
          workspaceId,
          connectionId,
          forgeRepoId: 'w17-24-repo',
          org: 'repopulse',
          name: 'w17-24-plans',
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        },
        {
          workspaceId,
          connectionId,
          forgeRepoId: 'w17-24-other',
          org: 'repopulse',
          name: 'w17-24-other',
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        },
      ])
      .returning();
    repoId = repos[0]!.id;
    otherRepoId = repos[1]!.id;

    // A breached M6 for the first repository, so its plan has an item
    // (`unreviewed-merges`), and a healthy one for the second, so its plan is
    // empty — two scopes whose content differs by construction.
    const snaps = await db
      .insert(read.metricSnapshots)
      .values([
        { workspaceId, repoId, metricKey: 'M6', window: WINDOW, dims: {}, value: '0.4' },
        { workspaceId, repoId: otherRepoId, metricKey: 'M6', window: WINDOW, dims: {}, value: '0' },
      ])
      .returning({ id: read.metricSnapshots.id });
    snapshotIds.push(...snaps.map((s) => s.id));

    cookie = await loginAs(app, PLANNER);
  });

  afterAll(async () => {
    // Only THIS file's rows: the dev database shares the default workspace.
    const planIds = (
      await db
        .select({ id: plansSchema.improvementPlans.id })
        .from(plansSchema.improvementPlans)
        .where(eq(plansSchema.improvementPlans.window, WINDOW))
    ).map((p) => p.id);
    if (planIds.length > 0) {
      const itemIds = (
        await db
          .select({ id: plansSchema.planItems.id })
          .from(plansSchema.planItems)
          .where(inArray(plansSchema.planItems.planId, planIds))
      ).map((i) => i.id);
      if (itemIds.length > 0) {
        await db
          .delete(plansSchema.planItemEvents)
          .where(inArray(plansSchema.planItemEvents.planItemId, itemIds));
        await db.delete(plansSchema.planItems).where(inArray(plansSchema.planItems.id, itemIds));
      }
      await db
        .delete(plansSchema.improvementPlans)
        .where(inArray(plansSchema.improvementPlans.id, planIds));
    }
    if (snapshotIds.length > 0) {
      await db.delete(read.metricSnapshots).where(inArray(read.metricSnapshots.id, snapshotIds));
    }
    await db.delete(core.repos).where(inArray(core.repos.id, [repoId, otherRepoId]));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, plannerUserId));
    await app.close();
    await new Promise<void>((r) => githubMock.close(() => r()));
  });

  it('a repeat generate for the same scope answers with the SAME plan, not a second one', async () => {
    const first = await generate({ window: WINDOW, repo_ids: [repoId] });
    expect(first.status).toBe(201);
    expect(first.body.reused).toBe(false);
    expect(first.body.repo_ids).toEqual([repoId]);
    expect(first.body.item_count).toBeGreaterThan(0);

    // Same repositories in a different spelling: still the same scope.
    const again = await generate({ window: WINDOW, repo_ids: [repoId, repoId] });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, reused: true });

    expect(await plansForScope([repoId])).toHaveLength(1);
  });

  it('concurrent generates for one scope land on ONE row', async () => {
    const before = await countPlans();
    const replies = await Promise.all(
      Array.from({ length: 4 }, () => generate({ window: WINDOW, repo_ids: [otherRepoId] })),
    );
    const ids = new Set(replies.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.filter((r) => r.status === 200 && r.body.reused)).toHaveLength(3);
    expect(await countPlans()).toBe(before + 1);
    expect(await plansForScope([otherRepoId])).toHaveLength(1);
  });

  it('a different scope is a different plan, recorded with exactly the repositories asked for', async () => {
    const repo = await generate({ window: WINDOW, repo_ids: [repoId] });
    const whole = await generate({ window: WINDOW, repo_ids: [] });
    expect(whole.status).toBe(201);
    expect(whole.body.id).not.toBe(repo.body.id);
    expect(whole.body.repo_ids).toEqual([]);

    const [row] = await db
      .select({ repoIds: plansSchema.improvementPlans.repoIds })
      .from(plansSchema.improvementPlans)
      .where(eq(plansSchema.improvementPlans.id, repo.body.id));
    expect(row?.repoIds).toEqual([repoId]);
  });

  it('refuses a repository this workspace cannot see, with a 404 and no plan', async () => {
    const before = await countPlans();
    const res = await generate({ window: WINDOW, repo_ids: [repoId, 2_147_483_000] });
    expect(res.status).toBe(404);
    expect(await countPlans()).toBe(before);
  });

  // W17-25: no human path to done, and no double-write under a race.
  async function patchItem(id: number, status: string) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/plans/items/${id}`,
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: { status },
    });
    return res.statusCode;
  }
  async function firstItemOf(planId: number) {
    const [row] = await db
      .select()
      .from(plansSchema.planItems)
      .where(eq(plansSchema.planItems.planId, planId))
      .orderBy(plansSchema.planItems.rank)
      .limit(1);
    return row!;
  }
  async function eventsTo(itemId: number, to: string) {
    return db
      .select()
      .from(plansSchema.planItemEvents)
      .where(
        and(
          eq(plansSchema.planItemEvents.planItemId, itemId),
          eq(plansSchema.planItemEvents.toStatus, to),
        ),
      );
  }

  it('a person cannot set done (or regressed) from ANY state, and no event says they did', async () => {
    const plan = await generate({ window: WINDOW, repo_ids: [repoId] });
    const item = await firstItemOf(plan.body.id);
    expect(item.status).toBe('proposed');

    expect(await patchItem(item.id, 'done')).toBe(409);
    expect(await patchItem(item.id, 'accepted')).toBe(200);
    expect(await patchItem(item.id, 'done')).toBe(409);
    expect(await patchItem(item.id, 'in_progress')).toBe(200);
    expect(await patchItem(item.id, 'done')).toBe(409);
    expect(await patchItem(item.id, 'regressed')).toBe(409);

    // Even from the verifier's own states.
    for (const state of ['done', 'regressed']) {
      await db
        .update(plansSchema.planItems)
        .set({ status: state })
        .where(eq(plansSchema.planItems.id, item.id));
      expect(await patchItem(item.id, 'done')).toBe(409);
    }
    expect(await eventsTo(item.id, 'done')).toHaveLength(0);
    expect(await eventsTo(item.id, 'regressed')).toHaveLength(0);
    expect((await firstItemOf(plan.body.id)).status).toBe('regressed');
  });

  it('two people who both read proposed cannot both accept it', async () => {
    const plan = await generate({ window: WINDOW, repo_ids: [repoId] });
    const item = await firstItemOf(plan.body.id);
    await db
      .update(plansSchema.planItems)
      .set({ status: 'proposed' })
      .where(eq(plansSchema.planItems.id, item.id));
    const before = (await eventsTo(item.id, 'accepted')).length;

    const codes = await Promise.all([
      patchItem(item.id, 'accepted'),
      patchItem(item.id, 'accepted'),
    ]);
    expect(codes.sort()).toEqual([200, 409]);
    expect((await eventsTo(item.id, 'accepted')).length).toBe(before + 1);
  });

  it('keeps the reason a person gave for a dismissal, and lets them restore it (W20-05, DSH-14)', async () => {
    const plan = await generate({ window: WINDOW, repo_ids: [repoId] });
    const item = await firstItemOf(plan.body.id);
    await db
      .update(plansSchema.planItems)
      .set({ status: 'proposed' })
      .where(eq(plansSchema.planItems.id, item.id));

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/plans/items/${item.id}`,
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: { status: 'dismissed', reason: 'Owned by the platform team' },
    });
    expect(res.statusCode).toBe(200);
    const events = await eventsTo(item.id, 'dismissed');
    expect(events.at(-1)?.reason).toBe('Owned by the platform team');

    // Restore is the dismissal's undo.
    expect(await patchItem(item.id, 'proposed')).toBe(200);

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/plans/items/${item.id}`,
      headers: CSRF,
      cookies: { repopulse_sid: cookie },
      payload: { status: 'dismissed', reason: 42 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('listing plans never creates one', async () => {
    const before = await countPlans();
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/plans',
        cookies: { repopulse_sid: cookie },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(await countPlans()).toBe(before);
  });
});
