import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import aiPassRoutes, { AI_PASSES_PER_DAY, cleanPaths } from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';

// W19-09. Starting a pass, watching it, reading what it suggested, and a person's
// answer to a suggestion. The property that matters most: deciding a suggestion
// stores the decision on the suggestion and changes NOTHING about the finding.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const CSRF = { 'x-requested-with': 'repopulse' };

describeIfLiveInfra('AI pass routes (W19-09)', () => {
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
  let clock = new Date('2026-10-18T12:00:00Z');
  let queueUp = true;

  async function clear() {
    for (const w of [WS, OTHER]) {
      await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, w));
      await db.delete(read.aiFindingProvenance).where(eq(read.aiFindingProvenance.workspaceId, w));
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, w));
    }
    await db.delete(read.findings).where(eq(read.findings.workspaceId, WS));
  }

  beforeAll(async () => {
    await db
      .insert(core.workspaces)
      .values({ slug: 'w19-09-routes', name: 'W19-09 routes' })
      .onConflictDoNothing();
    WS = (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, 'w19-09-routes'))
        .limit(1)
    )[0]!.id;
    await db
      .insert(core.workspaces)
      .values({ slug: 'w19-09-routes-other', name: 'Other' })
      .onConflictDoNothing();
    OTHER = (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, 'w19-09-routes-other'))
        .limit(1)
    )[0]!.id;
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w19-09-routes@example.test',
        login: 'tester',
        email: 'w19-09-routes@example.test',
      })
      .onConflictDoNothing();
    USER = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w19-09-routes@example.test'))
        .limit(1)
    )[0]!.id;
    const enc = credentials.encryptCredential('w19-09-routes-token', Buffer.alloc(32, 7));
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
        forgeRepoId: 'w19-09-routes-repo',
        org: 'w19-09',
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
      queueFor: () => (queueUp ? ({ add } as never) : undefined),
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
    queueUp = true;
    clock = new Date('2026-10-18T12:00:00Z');
  });

  const start = (body: unknown = { paths: ['src'] }, repo = REPO) =>
    app.inject({
      method: 'POST',
      url: `/repos/${repo}/ai-pass`,
      headers: CSRF,
      payload: body as object,
    });

  async function finding(over: Partial<typeof read.findings.$inferInsert> = {}) {
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
        file: 'a.ts',
        lineStart: 1,
        lineEnd: 1,
        evidence: 'e',
        recommendation: 'r',
        tier: 2,
        dedupKey: `w19-09-r-${Math.random().toString(36).slice(2)}`,
        status: 'open',
        ...over,
      })
      .returning({ id: read.findings.id });
    return f!.id;
  }
  async function verdict(
    findingId: number,
    over: Partial<typeof read.aiTriageVerdicts.$inferInsert> = {},
  ) {
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
        model: 'm',
        checklistVersion: 'triage.v1',
        rationale: 'because',
        citations: [{ file: 'a.ts', line: 1, text: 'x' }],
        ...over,
      })
      .returning({ id: read.aiTriageVerdicts.id });
    return v!.id;
  }

  describe('starting a pass', () => {
    it('queues a pass over the named paths and returns it pending', async () => {
      const res = await start({ paths: ['src/routes/', './lib/a.ts', 'src/routes'] });
      expect(res.statusCode).toBe(202);
      expect(res.json().run).toMatchObject({
        status: 'pending',
        paths: ['lib/a.ts', 'src/routes'],
      }); // cleaned, de-duplicated, sorted
      expect(add).toHaveBeenCalledOnce();
      expect((add.mock.calls[0] as unknown[])[1]).toMatchObject({
        workspaceId: WS,
        runId: res.json().run.id,
      });
    });

    it('is for admins: it spends model calls over the source', async () => {
      role = 'member';
      expect((await start()).statusCode).toBe(403);
      expect(add).not.toHaveBeenCalled();
    });

    it('refuses to review "everything": paths are required, bounded and plain', async () => {
      for (const body of [
        {},
        { paths: [] },
        { paths: [''] },
        { paths: ['/etc'] },
        { paths: ['../x'] },
        { paths: ['a\\b'] },
        { paths: [5] },
      ]) {
        expect((await start(body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(cleanPaths(Array.from({ length: 51 }, (_, i) => `d${i}`))).toMatch(/At most 50/);
      expect((await start({})).json().detail).toMatch(/never reads the whole repository/);
    });

    it('starts a pass on a pull request or a commit range, and records which', async () => {
      const pr = await start({ pull_request: 12 });
      expect(pr.statusCode).toBe(202);
      expect(pr.json().run).toMatchObject({
        mode: 'pull_request',
        pr_number: 12,
        paths: [],
        base_ref: null,
      });
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, WS));
      const range = await start({ base: 'ABCDEF1', head: '1234567890abcdef' });
      expect(range.statusCode).toBe(202);
      expect(range.json().run).toMatchObject({
        mode: 'commit_range',
        base_ref: 'abcdef1',
        head_ref: '1234567890abcdef',
        pr_number: null,
      });
      const [row] = await db
        .select()
        .from(read.aiPassRuns)
        .where(eq(read.aiPassRuns.id, range.json().run.id));
      expect([row!.mode, row!.baseRef, row!.headRef]).toEqual([
        'commit_range',
        'abcdef1',
        '1234567890abcdef',
      ]);
    });

    it('takes exactly one scope, and a scope that makes sense', async () => {
      for (const body of [
        { paths: ['src'], pull_request: 3 },
        { pull_request: 3, base: 'abcdef1', head: 'abcdef2' },
        { pull_request: 0 },
        { pull_request: '3' },
        { pull_request: 1.5 },
        { base: 'abcdef1' },
        { base: 'zz', head: 'abcdef2' },
        { base: 'abcdef1', head: 5 },
      ]) {
        expect((await start(body)).statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(add).not.toHaveBeenCalled();
    });

    it('returns the active pass instead of starting a second one', async () => {
      const a = (await start()).json().run.id;
      const again = await start();
      expect(again.statusCode).toBe(202);
      expect(again.json().run.id).toBe(a);
      expect(add).toHaveBeenCalledOnce();
    });

    it('is capped per day', async () => {
      for (let i = 0; i < AI_PASSES_PER_DAY; i++) {
        await db.insert(read.aiPassRuns).values({
          workspaceId: WS,
          repoId: REPO,
          paths: ['x'],
          status: 'succeeded',
          createdAt: new Date(clock.getTime() - 3600_000),
        });
      }
      const res = await start();
      expect(res.statusCode).toBe(429);
      expect(res.json().detail).toMatch(/limit 10/);
    });

    it('says plainly when the queue is unavailable, and records nothing', async () => {
      queueUp = false;
      expect((await start()).statusCode).toBe(503);
      expect(
        await db.select().from(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, WS)),
      ).toEqual([]);
    });

    it('404s a repository of another workspace', async () => {
      asWorkspace = OTHER;
      expect((await start()).statusCode).toBe(404);
    });
  });

  describe('watching passes', () => {
    it('a repository nobody has run a pass on returns NO runs - "not yet run", never an empty success', async () => {
      const res = await app.inject({ method: 'GET', url: `/repos/${REPO}/ai-pass` });
      expect(res.json()).toEqual({ runs: [] });
    });

    it('lists the recent passes with their status and reason, newest first', async () => {
      await db.insert(read.aiPassRuns).values({
        workspaceId: WS,
        repoId: REPO,
        paths: ['a'],
        status: 'failed',
        reasonCode: 'no_gateway',
        reason: 'No model.',
        createdAt: new Date('2026-10-17T00:00:00Z'),
      });
      await db.insert(read.aiPassRuns).values({
        workspaceId: WS,
        repoId: REPO,
        paths: ['b'],
        status: 'succeeded',
        createdAt: new Date('2026-10-18T00:00:00Z'),
        calls: 7,
      });
      const runs = (await app.inject({ method: 'GET', url: `/repos/${REPO}/ai-pass` })).json().runs;
      expect(runs.map((r: { paths: string[] }) => r.paths[0])).toEqual(['b', 'a']);
      expect(runs[1]).toMatchObject({
        status: 'failed',
        reason_code: 'no_gateway',
        reason: 'No model.',
      });
    });

    it("never shows another workspace's passes", async () => {
      await db
        .insert(read.aiPassRuns)
        .values({ workspaceId: WS, repoId: REPO, paths: ['a'], status: 'succeeded' });
      asWorkspace = OTHER;
      expect((await app.inject({ method: 'GET', url: `/repos/${REPO}/ai-pass` })).statusCode).toBe(
        404,
      );
    });
  });

  describe("reading a finding's AI side", () => {
    it('a finding no pass has covered has no AI side: raised_by null and no suggestions', async () => {
      const id = await finding();
      expect((await app.inject({ method: 'GET', url: `/findings/${id}/ai` })).json()).toEqual({
        raised_by: null,
        suggestions: [],
      });
    });

    it('returns suggestions with our copy of the cited lines, the model and route, and the proposed VEX', async () => {
      const id = await finding();
      await verdict(id, {
        vexJustification: 'inline_mitigations_already_exist',
        vexStatement: 'validated',
        route: { providerName: 'LM Studio', linkIndex: 0 },
      });
      const [s] = (await app.inject({ method: 'GET', url: `/findings/${id}/ai` })).json()
        .suggestions;
      expect(s).toMatchObject({
        verdict: 'likely_false_positive',
        model: 'm',
        decision: null,
        route: { providerName: 'LM Studio' },
        vex: { justification: 'inline_mitigations_already_exist', statement: 'validated' },
      });
      expect(s.citations[0]).toEqual({ file: 'a.ts', line: 1, text: 'x' });
      expect(s.patch).toEqual({ status: 'not_attempted', reason: null, diff: null });
    });

    it('says what the pass reviewed next to each suggestion: a pull request, a commit range, or typed paths', async () => {
      const id = await finding();
      const [pr] = await db
        .insert(read.aiPassRuns)
        .values({
          workspaceId: WS,
          repoId: REPO,
          paths: [],
          mode: 'pull_request',
          prNumber: 12,
          baseRef: 'main',
          headRef: 'abc1234def',
          commitSha: 'abc1234def',
          status: 'succeeded',
        })
        .returning({ id: read.aiPassRuns.id });
      await verdict(id, { aiPassRunId: pr!.id });
      await verdict(id, { decision: 'dismissed', decidedAt: new Date() });
      const body = (await app.inject({ method: 'GET', url: `/findings/${id}/ai` })).json();
      const modes = body.suggestions.map((s: { pass: { mode: string } }) => s.pass.mode).sort();
      expect(modes).toEqual(['paths', 'pull_request']);
      const prSuggestion = body.suggestions.find(
        (s: { pass: { mode: string } }) => s.pass.mode === 'pull_request',
      );
      expect(prSuggestion.pass).toMatchObject({
        id: pr!.id,
        pr_number: 12,
        base_ref: 'main',
        head_ref: 'abc1234def',
      });
    });

    it('404s a finding of another workspace and never leaks its suggestions', async () => {
      const id = await finding();
      await verdict(id);
      asWorkspace = OTHER;
      expect((await app.inject({ method: 'GET', url: `/findings/${id}/ai` })).statusCode).toBe(404);
    });
  });

  describe('a person answers a suggestion', () => {
    const decide = (findingId: number, verdictId: number, decision: unknown) =>
      app.inject({
        method: 'POST',
        url: `/findings/${findingId}/ai-verdicts/${verdictId}/decide`,
        headers: CSRF,
        payload: { decision },
      });

    it('records who and when on the suggestion - and does NOT touch the finding', async () => {
      const fid = await finding();
      const vid = await verdict(fid);
      const [before] = await db.select().from(read.findings).where(eq(read.findings.id, fid));
      const res = await decide(fid, vid, 'accepted');
      expect(res.statusCode).toBe(200);
      const [v] = await db
        .select()
        .from(read.aiTriageVerdicts)
        .where(eq(read.aiTriageVerdicts.id, vid));
      expect(v).toMatchObject({ decision: 'accepted', decidedBy: USER });
      expect(v!.decidedAt).toBeInstanceOf(Date);
      const [after] = await db.select().from(read.findings).where(eq(read.findings.id, fid));
      expect(after).toEqual(before); // status, dismissReason, statusChangedBy: all unchanged
      expect(after!.status).toBe('open');
    });

    it('accepts dismissing too, and records it the same way', async () => {
      const fid = await finding();
      const vid = await verdict(fid, { verdict: 'real' });
      expect((await decide(fid, vid, 'dismissed')).statusCode).toBe(200);
      expect(
        (await db.select().from(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.id, vid)))[0]!
          .decision,
      ).toBe('dismissed');
    });

    it('answers once: a second answer is a 409 and the first stands', async () => {
      const fid = await finding();
      const vid = await verdict(fid);
      await decide(fid, vid, 'accepted');
      const again = await decide(fid, vid, 'dismissed');
      expect(again.statusCode).toBe(409);
      expect(
        (await db.select().from(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.id, vid)))[0]!
          .decision,
      ).toBe('accepted');
    });

    it('accepts only accepted or dismissed - "superseded" is the system\'s, never a person\'s', async () => {
      const fid = await finding();
      const vid = await verdict(fid);
      for (const bad of ['superseded', 'maybe', undefined, 1]) {
        expect((await decide(fid, vid, bad)).statusCode, String(bad)).toBe(400);
      }
    });

    it('404s a suggestion of another workspace or another finding, and changes nothing', async () => {
      const fid = await finding();
      const other = await finding();
      const vid = await verdict(fid);
      expect((await decide(other, vid, 'accepted')).statusCode).toBe(404); // wrong finding
      asWorkspace = OTHER;
      expect((await decide(fid, vid, 'accepted')).statusCode).toBe(404); // wrong workspace
      expect(
        (await db.select().from(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.id, vid)))[0]!
          .decision,
      ).toBeNull();
    });
  });

  it('the database itself allows one undecided suggestion per finding', async () => {
    const fid = await finding();
    await verdict(fid);
    await expect(verdict(fid)).rejects.toThrow();
    // once answered, a newer suggestion may follow
    await db
      .update(read.aiTriageVerdicts)
      .set({ decision: 'dismissed', decidedAt: new Date() })
      .where(
        and(eq(read.aiTriageVerdicts.findingId, fid), eq(read.aiTriageVerdicts.workspaceId, WS)),
      );
    await expect(verdict(fid)).resolves.toBeTypeOf('number');
  });
});
