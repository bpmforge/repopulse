import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, read } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import aiPassRoutes from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';

// W19-12, the API side. A schedule is OFF until an admin enables it AND acknowledges
// where source would be sent (the digest from GET, so the server proves they were
// shown the CURRENT destinations). Real tables, real egress computation.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const CSRF = { 'x-requested-with': 'repopulse' };

describeIfLiveInfra('scheduled AI pass routes (W19-12)', () => {
  const db = createDb(databaseUrl as string);
  let app: FastifyInstance;
  let WS = 0;
  let OTHER = 0;
  let REPO = 0;
  let OTHER_REPO = 0;
  let USER = 0;
  let connectionId = 0;
  let asWorkspace = 0;
  let role: 'admin' | 'member' = 'admin';
  const clock = new Date('2026-10-18T12:00:00Z');

  async function clear() {
    for (const w of [WS, OTHER]) {
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, w));
      await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, w));
      await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, w));
      await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, w));
      await db.delete(core.llmRoutingPolicy).where(eq(core.llmRoutingPolicy.workspaceId, w));
      await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, w));
    }
  }
  async function ws(slug: string) {
    await db.insert(core.workspaces).values({ slug, name: slug }).onConflictDoNothing();
    return (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
  }
  async function provider(name: string, baseUrl: string, workspaceId = WS) {
    const [p] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId,
        name,
        kind: 'openai_compatible',
        baseUrl,
        model: 'm',
        allowPublicHost: !/^http:\/\/(10|127|192\.168)\./.test(baseUrl),
      })
      .returning({ id: core.llmProviders.id });
    return p!.id;
  }

  beforeAll(async () => {
    WS = await ws('w19-12-routes');
    OTHER = await ws('w19-12-routes-other');
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w19-12-routes@example.test',
        login: 'admin-ada',
        email: 'w19-12-routes@example.test',
      })
      .onConflictDoNothing();
    USER = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w19-12-routes@example.test'))
        .limit(1)
    )[0]!.id;
    const enc = credentials.encryptCredential('w19-12-routes-token', Buffer.alloc(32, 7));
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId: WS,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = conn!.id;
    const mk = async (workspaceId: number, name: string) =>
      (
        await db
          .insert(core.repos)
          .values({
            workspaceId,
            connectionId,
            forgeRepoId: `w19-12-r-${name}`,
            org: 'w19-12',
            name,
            defaultBranch: 'main',
            isPrivate: false,
            isArchived: false,
            syncStatus: 'live',
            tier2Auto: false,
          })
          .returning({ id: core.repos.id })
      )[0]!.id;
    REPO = await mk(WS, 'sched-routes');
    OTHER_REPO = await mk(OTHER, 'sched-routes-other');
    asWorkspace = WS;

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: asWorkspace, slug: 't', name: 't' };
      request.role = role;
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k) => (k === 'userId' ? USER : undefined),
      };
    });
    await app.register(aiPassRoutes, { db, queueFor: () => undefined, now: () => clock });
    await app.ready();
  });
  afterAll(async () => {
    await clear();
    await db.delete(core.repos).where(eq(core.repos.id, REPO));
    await db.delete(core.repos).where(eq(core.repos.id, OTHER_REPO));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, OTHER));
    await app.close();
    await db.$client.end();
  });
  beforeEach(async () => {
    await clear();
    asWorkspace = WS;
    role = 'admin';
  });

  const get = (repo = REPO) =>
    app.inject({ method: 'GET', url: `/repos/${repo}/ai-pass/schedule` });
  const put = (body: unknown, repo = REPO) =>
    app.inject({
      method: 'PUT',
      url: `/repos/${repo}/ai-pass/schedule`,
      headers: CSRF,
      payload: body as never,
    });
  const ack = async () => (await get()).json().egress.digest as string;
  const enable = async (over: Record<string, unknown> = {}) =>
    put({
      enabled: true,
      frequency: 'weekly',
      scope: { kind: 'paths', paths: ['src/payments'] },
      acknowledged_egress: await ack(),
      ...over,
    });

  it('a repository nobody has scheduled has NO schedule - off, not an empty one', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule).toBeNull();
    expect(res.json().monthly).toEqual({ cap: 300, used: 0, remaining: 300 });
    expect(res.json().runs).toEqual([]);
  });

  it('refuses to enable with no model configured, and says why', async () => {
    const res = await put({
      enabled: true,
      frequency: 'daily',
      scope: { kind: 'paths', paths: ['src'] },
      acknowledged_egress: 'x',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().detail).toMatch(/No model connection is configured/);
  });

  it('shows what stays home: a LAN model leaves nothing', async () => {
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    const e = (await get()).json().egress;
    expect(e).toMatchObject({ local_only: false, leaves_network: false });
    expect(e.destinations[0]).toMatchObject({
      provider_name: 'LM Studio',
      host: '10.0.0.5:1234',
      leaves_network: false,
    });
    expect(e.sentence).toMatch(/^Stays on your network/);
    expect(e.sends).toMatch(/diff of a pull request/);
  });

  it('enabling needs the acknowledgement of the CURRENT destinations, and is never immediate', async () => {
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    const noAck = await put({
      enabled: true,
      frequency: 'weekly',
      scope: { kind: 'paths', paths: ['src'] },
    });
    expect(noAck.statusCode).toBe(409);
    expect(noAck.json().title).toBe('Acknowledge where source is sent');
    const wrong = await enable({ acknowledged_egress: 'deadbeef' });
    expect(wrong.statusCode).toBe(409);
    expect(await db.select().from(read.aiPassSchedules)).toHaveLength(0);

    const ok = await enable();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().schedule).toMatchObject({
      enabled: true,
      frequency: 'weekly',
      scope: { kind: 'paths', paths: ['src/payments'] },
    });
    // The first run is one interval away, never at enable time.
    expect(new Date(ok.json().schedule.next_run_at).toISOString()).toBe('2026-10-25T12:00:00.000Z');
    expect(ok.json().schedule.acknowledged.destinations[0]).toMatchObject({
      host: '10.0.0.5:1234',
    });
    const read1 = (await get()).json();
    expect(read1.schedule.enabled).toBe(true);
    expect(read1.schedule.enabled_by).toBe('admin-ada');
    expect(read1.acknowledgement_stale).toBe(false);
  });

  it('a hosted model must be acknowledged as LEAVING the network, naming the host', async () => {
    await provider('Hosted', 'https://api.example.com/v1');
    const e = (await get()).json().egress;
    expect(e.leaves_network).toBe(true);
    expect(e.sentence).toMatch(/^Leaves your network: Hosted \(api\.example\.com\)/);
    expect((await enable()).statusCode).toBe(200);
  });

  it('local-only forbids a schedule whose models would leave the network', async () => {
    await provider('Hosted', 'https://api.example.com/v1');
    await db.insert(core.llmRoutingPolicy).values({ workspaceId: WS, localOnly: true });
    const res = await put({
      enabled: true,
      frequency: 'daily',
      scope: { kind: 'paths', paths: ['src'] },
      acknowledged_egress: await ack(),
    });
    // Under local-only the shared pool excludes the hosted connection entirely.
    expect(res.statusCode).toBe(409);
  });

  it('local-only with a role explicitly routed to a hosted link is refused with the reason', async () => {
    const hosted = await provider('Hosted', 'https://api.example.com/v1');
    await db.insert(core.llmRoleRoutes).values({
      workspaceId: WS,
      role: 'security',
      position: 0,
      providerId: hosted,
    });
    await db.insert(core.llmRoutingPolicy).values({ workspaceId: WS, localOnly: true });
    const res = await put({
      enabled: true,
      frequency: 'daily',
      scope: { kind: 'paths', paths: ['src'] },
      acknowledged_egress: await ack(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().title).toBe('Local-only forbids this');
    expect(res.json().detail).toMatch(/off your network/);
    expect(await db.select().from(read.aiPassSchedules)).toHaveLength(0);
  });

  it('a routing change after enabling makes the acknowledgement stale', async () => {
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    expect((await enable()).statusCode).toBe(200);
    await provider('Hosted', 'https://api.example.com/v1');
    const res = await get();
    expect(res.json().acknowledgement_stale).toBe(true);
    // Re-acknowledging the new destinations clears it.
    expect((await enable()).statusCode).toBe(200);
    expect((await get()).json().acknowledgement_stale).toBe(false);
  });

  it('W22-03: the optional triage_fast role is not sent anywhere until routed, so the digest stays', async () => {
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    const fast = await provider('LM Studio small', 'http://10.0.0.6:1234/v1');
    const before = (await get()).json().egress;
    const roles = (e: { destinations: { roles: string[] }[] }) =>
      e.destinations.flatMap((d) => d.roles);
    // Unrouted: the shared pool serves every pass role, never triage_fast.
    expect(roles(before)).not.toContain('triage_fast');
    await db
      .insert(core.llmRoleRoutes)
      .values({ workspaceId: WS, role: 'triage_fast', position: 0, providerId: fast });
    const after = (await get()).json().egress;
    expect(
      after.destinations.find((d: { provider_id: number }) => d.provider_id === fast).roles,
    ).toContain('triage_fast');
    expect(after.digest).not.toBe(before.digest);
  });

  it('validates frequency and scope, and bounds the paths like a manual pass', async () => {
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    for (const over of [
      { frequency: 'hourly' },
      { frequency: undefined },
      { scope: { kind: 'everything' } },
      { scope: { kind: 'paths', paths: [] } },
      { scope: { kind: 'paths', paths: ['../etc'] } },
      { scope: { kind: 'paths', paths: ['/abs'] } },
      { enabled: 'yes' },
    ]) {
      expect((await enable(over)).statusCode, JSON.stringify(over)).toBe(400);
    }
    const prs = await enable({ scope: { kind: 'new_pull_requests' } });
    expect(prs.statusCode).toBe(200);
    expect(prs.json().schedule.scope).toEqual({ kind: 'new_pull_requests', paths: [] });
  });

  it('only an admin can change a schedule; any member can read it', async () => {
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    role = 'member';
    expect((await enable()).statusCode).toBe(403);
    expect((await get()).statusCode).toBe(200);
    expect(await db.select().from(read.aiPassSchedules)).toHaveLength(0);
  });

  it('disabling keeps the configuration, clears the next run, and needs only the admin', async () => {
    await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    await enable();
    const res = await put({ enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule).toMatchObject({
      enabled: false,
      next_run_at: null,
      scope: { kind: 'paths', paths: ['src/payments'] },
    });
    // Disabling something never enabled is a no-op, not an error.
    await db.delete(read.aiPassSchedules);
    const none = await put({ enabled: false });
    expect(none.statusCode).toBe(200);
    expect(none.json().schedule).toBeNull();
  });

  it('lists the scheduled passes including the skipped ones with their reasons', async () => {
    await db.insert(read.aiPassRuns).values([
      {
        workspaceId: WS,
        repoId: REPO,
        paths: ['src'],
        trigger: 'scheduled',
        status: 'skipped',
        reasonCode: 'cap_reached',
        reason: 'The monthly cap is used up.',
      },
      { workspaceId: WS, repoId: REPO, paths: ['src'], trigger: 'manual', status: 'succeeded' },
    ]);
    const runs = (await get()).json().runs;
    expect(runs).toHaveLength(1); // only the scheduled one
    expect(runs[0]).toMatchObject({ status: 'skipped', reason_code: 'cap_reached' });
  });

  it('is workspace-scoped: another workspace’s repo is a 404 and its schedule never shows', async () => {
    expect((await get(OTHER_REPO)).statusCode).toBe(404);
    expect((await put({ enabled: false }, OTHER_REPO)).statusCode).toBe(404);
    await db.insert(read.aiPassSchedules).values({
      workspaceId: OTHER,
      repoId: OTHER_REPO,
      enabled: true,
      egressDigest: 'd',
      enabledAt: new Date(),
    });
    expect((await get()).json().schedule).toBeNull();
  });

  describe('the monthly call cap', () => {
    it('defaults to 300 and is set by an admin, 0 to 100000', async () => {
      const def = await app.inject({ method: 'GET', url: '/ai-pass/settings' });
      expect(def.json()).toMatchObject({ monthly_call_cap: 300, default_cap: 300, used: 0 });
      const set = await app.inject({
        method: 'PUT',
        url: '/ai-pass/settings',
        headers: CSRF,
        payload: { monthly_call_cap: 120 },
      });
      expect(set.json()).toMatchObject({ monthly_call_cap: 120, remaining: 120 });
      expect(
        (await app.inject({ method: 'GET', url: '/ai-pass/settings' })).json().monthly_call_cap,
      ).toBe(120);
      const zero = await app.inject({
        method: 'PUT',
        url: '/ai-pass/settings',
        headers: CSRF,
        payload: { monthly_call_cap: 0 },
      });
      expect(zero.statusCode).toBe(200);
    });

    it('rejects nonsense and non-admins', async () => {
      for (const v of [-1, 1.5, '5', null, 100_001]) {
        const res = await app.inject({
          method: 'PUT',
          url: '/ai-pass/settings',
          headers: CSRF,
          payload: { monthly_call_cap: v } as never,
        });
        expect(res.statusCode, String(v)).toBe(400);
      }
      role = 'member';
      const res = await app.inject({
        method: 'PUT',
        url: '/ai-pass/settings',
        headers: CSRF,
        payload: { monthly_call_cap: 50 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('W22-03: sets the local judge minutes on their own, null back to the server default', async () => {
      const def = (await app.inject({ method: 'GET', url: '/ai-pass/settings' })).json();
      expect(def).toMatchObject({
        judge_minutes_per_day: null,
        judge_default_minutes_per_day: 240,
        judge_minutes_used: 0,
        judge_minutes_remaining: 240,
      });
      const set = await app.inject({
        method: 'PUT',
        url: '/ai-pass/settings',
        headers: CSRF,
        payload: { judge_minutes_per_day: 90 },
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ judge_minutes_per_day: 90, judge_minutes_remaining: 90 });
      // The call cap is untouched by it.
      expect(
        (await app.inject({ method: 'GET', url: '/ai-pass/settings' })).json().monthly_call_cap,
      ).toBe(300);
      for (const v of [-1, 1.5, '5', 1441]) {
        const bad = await app.inject({
          method: 'PUT',
          url: '/ai-pass/settings',
          headers: CSRF,
          payload: { judge_minutes_per_day: v } as never,
        });
        expect(bad.statusCode, String(v)).toBe(400);
      }
      const reset = await app.inject({
        method: 'PUT',
        url: '/ai-pass/settings',
        headers: CSRF,
        payload: { judge_minutes_per_day: null },
      });
      expect(reset.json()).toMatchObject({
        judge_minutes_per_day: null,
        judge_minutes_remaining: 240,
      });
    });

    it('counts this workspace’s calls this month only', async () => {
      await db.insert(read.aiPassRuns).values([
        {
          workspaceId: WS,
          repoId: REPO,
          paths: ['x'],
          status: 'succeeded',
          calls: 12,
          createdAt: clock,
        },
        {
          workspaceId: WS,
          repoId: REPO,
          paths: ['x'],
          status: 'succeeded',
          calls: 50,
          createdAt: new Date('2026-09-30T23:00:00Z'),
        },
        {
          workspaceId: OTHER,
          repoId: OTHER_REPO,
          paths: ['x'],
          status: 'succeeded',
          calls: 70,
          createdAt: clock,
        },
      ]);
      const res = await app.inject({ method: 'GET', url: '/ai-pass/settings' });
      expect(res.json()).toMatchObject({ used: 12, remaining: 288 });
    });
  });
});
