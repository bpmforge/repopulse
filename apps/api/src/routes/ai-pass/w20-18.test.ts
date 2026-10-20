import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import aiPassRoutes, { AI_PASSES_PER_DAY } from './index.js';
import { parseRunWindow } from './schedule.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import { AI_PAUSED_PROBLEM } from '../../lib/ai-pause.js';

// W20-18, the product decisions of 2026-10-20, against real tables:
//   AI-14  a second opinion from ANOTHER model; a hosted (off-network) model only on
//          a repository opted in to Tier 3; it is a pass, so it counts toward the
//          daily pass limit; it is shown beside the suggestion and never answered alone.
//   AI-77  the workspace-wide "AI off" switch refuses passes and second opinions; every
//          schedule in one list, and "turn off every schedule".
//   AI-53  a run window in the server's hours, with the zone named by the API.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const CSRF = { 'x-requested-with': 'repopulse' };

describe('parseRunWindow (AI-53)', () => {
  it('accepts null (any time) or two different whole hours', () => {
    expect(parseRunWindow(undefined)).toEqual({ start: null, end: null });
    expect(parseRunWindow(null)).toEqual({ start: null, end: null });
    expect(parseRunWindow({ start_hour: 22, end_hour: 5 })).toEqual({ start: 22, end: 5 });
    expect(parseRunWindow({ start_hour: 3, end_hour: 3 })).toMatch(/differ/);
    expect(parseRunWindow({ start_hour: 24, end_hour: 3 })).toMatch(/0 to 23/);
    expect(parseRunWindow({ start_hour: 1.5, end_hour: 3 })).toMatch(/0 to 23/);
    expect(parseRunWindow('2-6')).toMatch(/start_hour/);
  });
});

describeIfLiveInfra('W20-18 AI decisions (routes)', () => {
  const db = createDb(databaseUrl as string);
  let app: FastifyInstance;
  let WS = 0;
  let OTHER = 0;
  let REPO = 0;
  let USER = 0;
  let connectionId = 0;
  let scanRunId = 0;
  let asWorkspace = 0;
  let role: 'admin' | 'member' = 'admin';
  const add = vi.fn(async () => ({ id: 'job' }));
  const clock = new Date('2026-10-20T12:00:00Z');

  async function clear() {
    for (const w of [WS, OTHER]) {
      await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, w));
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, w));
      await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, w));
      await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, w));
      await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, w));
      await db.delete(core.llmRoutingPolicy).where(eq(core.llmRoutingPolicy.workspaceId, w));
      await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, w));
    }
    await db.delete(read.findings).where(eq(read.findings.workspaceId, WS));
    await db.update(core.repos).set({ tier3OptIn: false }).where(eq(core.repos.id, REPO));
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
  async function provider(name: string, baseUrl: string, model: string, workspaceId = WS) {
    const [p] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId,
        name,
        kind: 'openai_compatible',
        baseUrl,
        model,
        allowPublicHost: !/^http:\/\/(10|127|192\.168)\./.test(baseUrl),
      })
      .returning({ id: core.llmProviders.id });
    return p!.id;
  }

  beforeAll(async () => {
    WS = await ws('w20-18-routes');
    OTHER = await ws('w20-18-routes-other');
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w20-18-routes@example.test',
        login: 'admin-ada',
        email: 'w20-18-routes@example.test',
      })
      .onConflictDoNothing();
    USER = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w20-18-routes@example.test'))
        .limit(1)
    )[0]!.id;
    const enc = credentials.encryptCredential('w20-18-routes-token', Buffer.alloc(32, 7));
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
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: WS,
        connectionId,
        forgeRepoId: 'w20-18-routes-repo',
        org: 'w20-18',
        name: 'routes',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    REPO = repo!.id;
    const [sr] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId: WS,
        repoId: REPO,
        scannerKey: 'semgrep',
        scannerVersion: 'test',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning({ id: security.scanRuns.id });
    scanRunId = sr!.id;
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
    await app.register(aiPassRoutes, {
      db,
      queueFor: () => ({ add }) as never,
      now: () => clock,
    });
    await app.ready();
  });
  afterAll(async () => {
    await clear();
    await db.delete(security.scanRuns).where(eq(security.scanRuns.id, scanRunId));
    await db.delete(core.repos).where(eq(core.repos.id, REPO));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, OTHER));
    await app.close();
    await db.$client.end();
  });
  beforeEach(async () => {
    await clear();
    add.mockClear();
    asWorkspace = WS;
    role = 'admin';
  });

  async function finding() {
    const [f] = await db
      .insert(read.findings)
      .values({
        workspaceId: WS,
        repoId: REPO,
        scanRunId,
        dimension: 'sast',
        severity: 4,
        confidence: 4,
        title: 't',
        scannerKey: 'semgrep',
        ruleId: 'r',
        file: 'src/a.ts',
        lineStart: 2,
        lineEnd: 2,
        evidence: 'e',
        recommendation: 'r',
        tier: 2,
        contextLines: 'a\nb\nc',
        contextStartLine: 1,
        dedupKey: `w20-18-${Math.random().toString(36).slice(2)}`,
        status: 'open',
      })
      .returning({ id: read.findings.id });
    return f!.id;
  }
  async function firstOpinion(findingId: number, model = 'local-a') {
    const [run] = await db
      .insert(read.aiPassRuns)
      .values({ workspaceId: WS, repoId: REPO, paths: ['src'], status: 'succeeded' })
      .returning({ id: read.aiPassRuns.id });
    const [v] = await db
      .insert(read.aiTriageVerdicts)
      .values({
        workspaceId: WS,
        findingId,
        aiPassRunId: run!.id,
        verdict: 'likely_false_positive',
        confidence: 4,
        model,
        checklistVersion: 'triage.v1',
        rationale: 'because',
        citations: [{ file: 'src/a.ts', line: 2, text: 'b' }],
      })
      .returning({ id: read.aiTriageVerdicts.id });
    return { runId: run!.id, verdictId: v!.id };
  }
  const ask = (fid: number, vid: number, body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/findings/${fid}/ai-verdicts/${vid}/second-opinion`,
      headers: CSRF,
      payload: body,
    });
  const aiOf = async (fid: number) =>
    (await app.inject({ method: 'GET', url: `/findings/${fid}/ai` })).json();

  describe('AI-14 second opinion', () => {
    it('asks a different model on your network, as a pass row, and queues it', async () => {
      await provider('LM same', 'http://10.0.0.5:1234/v1', 'local-a');
      const other = await provider('LM other', 'http://10.0.0.6:1234/v1', 'local-b');
      const fid = await finding();
      const { verdictId } = await firstOpinion(fid);

      const info = (await aiOf(fid)).second_opinion;
      // The model that answered first is not offered.
      expect(info.choices).toEqual([
        {
          provider_id: other,
          provider_name: 'LM other',
          host: '10.0.0.6:1234',
          model: 'local-b',
          leaves_network: false,
        },
      ]);
      expect(info).toMatchObject({ of: verdictId, passes_per_day: AI_PASSES_PER_DAY });

      const res = await ask(fid, verdictId);
      expect(res.statusCode).toBe(202);
      expect(res.json().run).toMatchObject({ mode: 'second_opinion', status: 'pending' });
      expect(res.json().destination).toMatchObject({ provider_id: other, model: 'local-b' });
      expect(add).toHaveBeenCalledOnce();
      expect((await aiOf(fid)).second_opinion.latest).toMatchObject({ status: 'pending' });
      expect((await aiOf(fid)).second_opinion.passes_today).toBe(2);
    });

    it('offers a hosted model only when the repository is opted in to Tier 3', async () => {
      const hosted = await provider('Hosted', 'https://api.example.com/v1', 'hosted-x');
      const fid = await finding();
      const { verdictId } = await firstOpinion(fid);

      let info = (await aiOf(fid)).second_opinion;
      expect(info.choices).toEqual([]);
      expect(info.blocked[0]).toMatchObject({ provider_name: 'Hosted' });
      expect(info.blocked[0].reason).toMatch(/not opted in to Tier 3/);
      const refused = await ask(fid, verdictId, { provider_id: hosted });
      expect(refused.statusCode).toBe(409);
      expect(add).not.toHaveBeenCalled();

      await db.update(core.repos).set({ tier3OptIn: true }).where(eq(core.repos.id, REPO));
      info = (await aiOf(fid)).second_opinion;
      expect(info.choices[0]).toMatchObject({ provider_id: hosted, leaves_network: true });
      const ok = await ask(fid, verdictId, { provider_id: hosted });
      expect(ok.statusCode).toBe(202);
      expect(ok.json().destination).toMatchObject({
        leaves_network: true,
        host: 'api.example.com',
      });

      // Local-only still forbids it, opt-in or not.
      await db
        .delete(read.aiPassRuns)
        .where(
          and(eq(read.aiPassRuns.workspaceId, WS), eq(read.aiPassRuns.mode, 'second_opinion')),
        );
      await db
        .insert(core.llmRoutingPolicy)
        .values({ workspaceId: WS, localOnly: true })
        .onConflictDoUpdate({
          target: core.llmRoutingPolicy.workspaceId,
          set: { localOnly: true },
        });
      info = (await aiOf(fid)).second_opinion;
      expect(info.choices).toEqual([]);
      expect(info.blocked[0].reason).toMatch(/local-only/);
    });

    it('counts against the daily pass limit', async () => {
      await provider('LM other', 'http://10.0.0.6:1234/v1', 'local-b');
      const fid = await finding();
      const { verdictId } = await firstOpinion(fid);
      for (let i = 0; i < AI_PASSES_PER_DAY; i++) {
        await db.insert(read.aiPassRuns).values({
          workspaceId: WS,
          repoId: REPO,
          paths: ['x'],
          status: 'succeeded',
          createdAt: new Date(clock.getTime() - 60_000),
        });
      }
      const res = await ask(fid, verdictId);
      expect(res.statusCode).toBe(429);
      expect(res.json().detail).toMatch(/A second opinion counts as a pass/);
    });

    it('is for admins, and never for another workspace', async () => {
      await provider('LM other', 'http://10.0.0.6:1234/v1', 'local-b');
      const fid = await finding();
      const { verdictId } = await firstOpinion(fid);
      role = 'member';
      expect((await ask(fid, verdictId)).statusCode).toBe(403);
      role = 'admin';
      asWorkspace = OTHER;
      expect((await ask(fid, verdictId)).statusCode).toBe(404);
      expect(add).not.toHaveBeenCalled();
    });

    it('a second opinion sits beside an unanswered suggestion and cannot be answered alone', async () => {
      const fid = await finding();
      const { runId, verdictId } = await firstOpinion(fid);
      // The one-open index leaves second opinions out.
      const [second] = await db
        .insert(read.aiTriageVerdicts)
        .values({
          workspaceId: WS,
          findingId: fid,
          aiPassRunId: (
            await db
              .insert(read.aiPassRuns)
              .values({
                workspaceId: WS,
                repoId: REPO,
                paths: ['src/a.ts'],
                mode: 'second_opinion',
                status: 'succeeded',
              })
              .returning({ id: read.aiPassRuns.id })
          )[0]!.id,
          secondOpinionOf: verdictId,
          verdict: 'real',
          confidence: 3,
          model: 'local-b',
          checklistVersion: 'triage.v1',
          rationale: 'no',
          citations: [],
        })
        .returning({ id: read.aiTriageVerdicts.id });
      expect(runId).toBeGreaterThan(0);
      const ai = await aiOf(fid);
      expect(
        ai.suggestions.find((s: { id: number }) => s.id === second!.id).second_opinion_of,
      ).toBe(verdictId);
      const decide = await app.inject({
        method: 'POST',
        url: `/findings/${fid}/ai-verdicts/${second!.id}/decide`,
        headers: CSRF,
        payload: { decision: 'accepted' },
      });
      expect(decide.statusCode).toBe(409);
      expect(decide.json().title).toMatch(/not answered on its own/);
      const again = await ask(fid, second!.id);
      expect(again.statusCode).toBe(409);
    });
  });

  describe('AI-77 the AI switch', () => {
    const pause = (paused: unknown) =>
      app.inject({ method: 'PUT', url: '/ai-pass/pause', headers: CSRF, payload: { paused } });

    it('is admin-only, refuses a pass and a second opinion with a typed problem, and resumes', async () => {
      role = 'member';
      expect((await pause(true)).statusCode).toBe(403);
      role = 'admin';
      expect((await pause('yes')).statusCode).toBe(400);
      const res = await pause(true);
      expect(res.statusCode).toBe(200);
      expect(res.json().ai_paused).toMatchObject({ paused: true, paused_by: 'admin-ada' });

      const pass = await app.inject({
        method: 'POST',
        url: `/repos/${REPO}/ai-pass`,
        headers: CSRF,
        payload: { paths: ['src'] },
      });
      expect(pass.statusCode).toBe(409);
      expect(pass.json().type).toBe(AI_PAUSED_PROBLEM);
      expect(pass.json().detail).toMatch(/switched off for this workspace by admin-ada/);

      await provider('LM other', 'http://10.0.0.6:1234/v1', 'local-b');
      const fid = await finding();
      const { verdictId } = await firstOpinion(fid);
      const second = await ask(fid, verdictId);
      expect(second.statusCode).toBe(409);
      expect(second.json().type).toBe(AI_PAUSED_PROBLEM);
      expect(add).not.toHaveBeenCalled();
      expect((await aiOf(fid)).ai_paused.paused).toBe(true);

      // Another workspace is not paused by this one (Law 5).
      asWorkspace = OTHER;
      expect(
        (await app.inject({ method: 'GET', url: '/ai-pass/settings' })).json().ai_paused.paused,
      ).toBe(false);
      asWorkspace = WS;

      expect((await pause(false)).json().ai_paused).toEqual({
        paused: false,
        paused_by: null,
        paused_at: null,
      });
      const ok = await app.inject({
        method: 'POST',
        url: `/repos/${REPO}/ai-pass`,
        headers: CSRF,
        payload: { paths: ['src'] },
      });
      expect(ok.statusCode).toBe(202);
    });

    it('lists every schedule in the workspace and turns them all off', async () => {
      await provider('LM', 'http://10.0.0.5:1234/v1', 'local-a');
      const digest = (
        await app.inject({ method: 'GET', url: `/repos/${REPO}/ai-pass/schedule` })
      ).json().egress.digest;
      const put = await app.inject({
        method: 'PUT',
        url: `/repos/${REPO}/ai-pass/schedule`,
        headers: CSRF,
        payload: {
          enabled: true,
          frequency: 'daily',
          scope: { kind: 'paths', paths: ['src'] },
          window: { start_hour: 1, end_hour: 6 },
          acknowledged_egress: digest,
        },
      });
      expect(put.statusCode).toBe(200);

      role = 'member';
      expect((await app.inject({ method: 'GET', url: '/ai-pass/schedules' })).statusCode).toBe(403);
      role = 'admin';
      const list = (await app.inject({ method: 'GET', url: '/ai-pass/schedules' })).json();
      expect(list.server_time_zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(list.schedules).toHaveLength(1);
      expect(list.schedules[0]).toMatchObject({
        repo: { id: REPO, name: 'routes' },
        enabled: true,
        window: { start_hour: 1, end_hour: 6 },
        enabled_by: 'admin-ada',
      });

      const off = await app.inject({
        method: 'POST',
        url: '/ai-pass/schedules/disable-all',
        headers: CSRF,
      });
      expect(off.json()).toEqual({ disabled: 1 });
      const [row] = await db
        .select()
        .from(read.aiPassSchedules)
        .where(
          and(eq(read.aiPassSchedules.workspaceId, WS), eq(read.aiPassSchedules.repoId, REPO)),
        );
      expect(row).toMatchObject({ enabled: false, nextRunAt: null, windowStartHour: 1 });
    });
  });

  describe('AI-53 run window', () => {
    it('stores the window in server hours, names the zone, and starts the first run inside it', async () => {
      await provider('LM', 'http://10.0.0.5:1234/v1', 'local-a');
      const get = async () =>
        (await app.inject({ method: 'GET', url: `/repos/${REPO}/ai-pass/schedule` })).json();
      const digest = (await get()).egress.digest;
      const put = (window: unknown) =>
        app.inject({
          method: 'PUT',
          url: `/repos/${REPO}/ai-pass/schedule`,
          headers: CSRF,
          payload: {
            enabled: true,
            frequency: 'daily',
            scope: { kind: 'paths', paths: ['src'] },
            window,
            acknowledged_egress: digest,
          },
        });
      expect((await put({ start_hour: 4, end_hour: 4 })).statusCode).toBe(400);
      expect((await put({ start_hour: 2, end_hour: 5 })).statusCode).toBe(200);
      const body = await get();
      expect(body.server_time_zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(body.schedule.window).toEqual({ start_hour: 2, end_hour: 5 });
      const next = new Date(body.schedule.next_run_at);
      expect(next.getHours()).toBeGreaterThanOrEqual(2);
      expect(next.getHours()).toBeLessThan(5);
      expect(next.getTime()).toBeGreaterThanOrEqual(clock.getTime() + 86_400_000 - 86_400_000);
      // Without a window: any time, as before.
      expect((await put(null)).statusCode).toBe(200);
      expect((await get()).schedule.window).toBeNull();
    });
  });
});
