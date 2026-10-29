import 'dotenv/config';
import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import type { AnalysisGateway, CompleteOpts, CompleteResult, T2Host } from '@repopulse/analysis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiPassProcessor, type AiPassDeps, type AiPassJobData } from './ai-pass-processor.js';
import {
  judgeConfigFromEnv,
  judgeEligibility,
  orderJudgeQueue,
  queueJudgeAfterScan,
  type EgressOf,
  type JudgeConfig,
  type JudgeSummary,
} from './ai-judge.js';
import { monthlyCallsUsed } from './ai-pass-scheduler.js';
import type { PassEgress } from '../lib/ai-pass-egress.js';

// W22-03. The AI judges every rule hit after a scan: local by default and
// bounded by time, hosted only when opted in and on the call cap, and a
// verdict MARKS a finding - it never dismisses, resolves or suppresses it.

describe('orderJudgeQueue (risk order, grouped by rule)', () => {
  const hit = (id: number, rule: string, risk: number) => ({
    id,
    scannerKey: 'semgrep',
    ruleId: rule,
    effectiveRisk: String(risk),
  });

  it('puts the rule with the riskiest hit first, its hits in risk order, then the next rule', () => {
    const q = orderJudgeQueue([
      hit(1, 'a', 50),
      hit(2, 'b', 90),
      hit(3, 'a', 70),
      hit(4, 'b', 10),
      hit(5, 'c', 60),
    ]);
    expect(q.map((r) => r.id)).toEqual([2, 4, 3, 1, 5]);
  });

  it('caps the hits of one rule per run, so a noisy rule cannot take the whole budget', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => hit(i + 1, 'noisy', 90 - i)),
      hit(99, 'other', 5),
    ];
    const q = orderJudgeQueue(rows, 3);
    expect(q.map((r) => r.id)).toEqual([1, 2, 3, 99]);
  });

  it('breaks ties on ids, so two runs judge the same hits', () => {
    const q = orderJudgeQueue([hit(7, 'x', 10), hit(3, 'y', 10), hit(5, 'x', 10)]);
    expect(q.map((r) => r.id)).toEqual([3, 5, 7]);
  });
});

describe('judgeConfigFromEnv', () => {
  it('defaults to on, 240 minutes a day and 30 a run', () => {
    expect(judgeConfigFromEnv({})).toEqual({ enabled: true, minutesPerDay: 240, scanMinutes: 30 });
  });
  it("reads 'off' and whole minutes, and ignores nonsense", () => {
    expect(
      judgeConfigFromEnv({
        AI_JUDGE: 'off',
        AI_JUDGE_MINUTES_PER_DAY: '60',
        AI_JUDGE_SCAN_MINUTES: 'lots',
      }),
    ).toEqual({ enabled: false, minutesPerDay: 60, scanMinutes: 30 });
    expect(judgeConfigFromEnv({ AI_JUDGE_MINUTES_PER_DAY: '5000' }).minutesPerDay).toBe(240);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const SOURCE = [
  'export function register(app) {',
  "  app.get('/u/:id', async (req, res) => {",
  '    const rows = await db.query("SELECT * FROM users WHERE id = " + req.params.id);',
  '    res.json(rows);',
  '  });',
  '}',
].join('\n');

const egressOf =
  (leaves: boolean, extra: Partial<PassEgress> = {}): EgressOf =>
  async () => ({
    local_only: false,
    destinations: [
      {
        provider_id: 1,
        provider_name: leaves ? 'Hosted' : 'LM Studio',
        host: leaves ? 'api.example.com' : '10.0.0.5',
        leaves_network: leaves,
        roles: ['triage'],
      },
    ],
    leaves_network: leaves,
    digest: leaves ? 'hosted-digest' : 'local-digest',
    sentence: 'test',
    ...extra,
  });

/**
 * A scripted triage model. `verdictFor(title)` picks the verdict by the
 * finding's title in the prompt; `throwFor` makes the call throw (a timeout).
 */
function scripted(
  opts: {
    verdictFor?: (prompt: string) => string;
    throwFor?: (prompt: string) => boolean;
    onCall?: () => void;
  } = {},
) {
  const prompts: string[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt: string, o: CompleteOpts): Promise<CompleteResult> {
      prompts.push(prompt);
      opts.onCall?.();
      expect(o.meta.role).toBe('triage');
      expect(o.meta.initiator).toBe('ai-judge');
      if (opts.throwFor?.(prompt)) throw new Error('The model did not answer within 300 s');
      const flagged = /Flagged lines: (\d+)-/.exec(prompt)?.[1] ?? '1';
      const line = new RegExp(`^\\s*${flagged}\\| (.*)$`, 'm').exec(prompt)?.[1] ?? '';
      const verdict = opts.verdictFor?.(prompt) ?? 'real';
      return {
        text: JSON.stringify({
          verdict,
          confidence: 4,
          citations: [{ line: Number(flagged), quote: line.trim().slice(0, 30) }],
          rationale: `judged ${verdict} from the cited line`,
          vex_justification:
            verdict === 'likely_false_positive' ? 'inline_mitigations_already_exist' : null,
          vex_statement: verdict === 'likely_false_positive' ? 'validated upstream' : null,
          patch: null,
        }),
        model: 'scripted-model',
        tokensIn: 100,
        tokensOut: 20,
        costUsd: null,
        durationMs: 1,
        route: {
          role: 'triage',
          providerId: 1,
          providerName: 'LM Studio',
          model: 'scripted-model',
          linkIndex: 0,
          failedLinks: [],
        },
      };
    },
    async health() {
      return { ok: true };
    },
  };
  return { gateway, prompts };
}

describeIfLiveInfra('the AI judge after a scan (W22-03)', () => {
  const db = createDb(databaseUrl as string);
  let WS = 0;
  let OTHER = 0;
  let REPO = 0;
  let OTHER_REPO = 0;
  let scanRunId = 0;
  let otherScanRunId = 0;
  const connections: number[] = [];
  const CFG: JudgeConfig = { enabled: true, minutesPerDay: 240, scanMinutes: 30 };

  async function clear() {
    for (const w of [WS, OTHER]) {
      if (!w) continue;
      await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, w));
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, w));
      await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, w));
      await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, w));
      await db.delete(read.findings).where(eq(read.findings.workspaceId, w));
    }
  }

  async function workspace(slug: string) {
    await db.insert(core.workspaces).values({ slug, name: slug }).onConflictDoNothing();
    return (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
  }

  async function repoIn(ws: number, key: string, userId: number) {
    const enc = credentials.encryptCredential('w22-03-fixture', Buffer.alloc(32, 7));
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId: ws,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
        createdBy: userId,
      })
      .returning({ id: core.forgeConnections.id });
    connections.push(conn!.id);
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: ws,
        connectionId: conn!.id,
        forgeRepoId: key,
        org: 'w22-03',
        name: key,
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    const [sr] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId: ws,
        repoId: repo!.id,
        scannerKey: 'semgrep',
        scannerVersion: 'test',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning({ id: security.scanRuns.id });
    return { repoId: repo!.id, scanRunId: sr!.id };
  }

  beforeAll(async () => {
    WS = await workspace('w22-03-ws');
    OTHER = await workspace('w22-03-other');
    await clear();
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w22-03@example.test',
        login: 'w22-03',
        email: 'w22-03@example.test',
      })
      .onConflictDoNothing();
    const userId = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w22-03@example.test'))
        .limit(1)
    )[0]!.id;
    ({ repoId: REPO, scanRunId } = await repoIn(WS, `w22-03-repo-${Date.now()}`, userId));
    ({ repoId: OTHER_REPO, scanRunId: otherScanRunId } = await repoIn(
      OTHER,
      `w22-03-other-${Date.now()}`,
      userId,
    ));
  });
  afterAll(async () => {
    await clear();
    await db
      .delete(security.scanRuns)
      .where(inArray(security.scanRuns.id, [scanRunId, otherScanRunId]));
    await db.delete(core.repos).where(inArray(core.repos.id, [REPO, OTHER_REPO]));
    await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.id, connections));
    await db.$client.end();
  });
  beforeEach(clear);

  /** An open rule hit with the stored code context a scan keeps. */
  async function ruleHit(over: Partial<typeof read.findings.$inferInsert> = {}) {
    const [f] = await db
      .insert(read.findings)
      .values({
        workspaceId: WS,
        repoId: REPO,
        scanRunId,
        dimension: 'sast',
        severity: 4,
        confidence: 4,
        title: 'SQL built by concatenation',
        scannerKey: 'semgrep',
        ruleId: 'sql-concat',
        file: 'src/routes/users.ts',
        lineStart: 3,
        lineEnd: 3,
        evidence: 'db.query("SELECT * FROM users WHERE id = " + req.params.id)',
        recommendation: 'parameterise',
        tier: 2,
        dedupKey: `w22-03-${Math.random().toString(36).slice(2)}`,
        status: 'open',
        effectiveRisk: '50.00',
        contextLines: SOURCE,
        contextStartLine: 1,
        ...over,
      })
      .returning({ id: read.findings.id });
    return f!.id;
  }

  const finding = async (id: number) =>
    (await db.select().from(read.findings).where(eq(read.findings.id, id)))[0]!;
  const runOf = async (id: number) =>
    (await db.select().from(read.aiPassRuns).where(eq(read.aiPassRuns.id, id)))[0]!;
  const job = (runId: number, workspaceId = WS) =>
    ({ data: { workspaceId, runId } }) as Job<AiPassJobData>;

  function processor(
    gw: ReturnType<typeof scripted>,
    over: {
      config?: JudgeConfig;
      egress?: EgressOf;
      now?: () => Date;
      afterVerdicts?: () => Promise<void>;
    } = {},
  ) {
    const d: AiPassDeps = {
      db,
      gatewayFor: async () => ({
        gateway: gw.gateway,
        hosts: [
          {
            baseUrl: 'http://10.0.0.5:1234/v1',
            modelSlot: 'scripted-model',
            contextWindow: 32768,
          } as T2Host,
        ],
      }),
      loadSources: async () => ({ ok: false, code: 'unused', reason: 'unused' }),
      ...(over.now ? { now: over.now } : {}),
      judge: {
        config: over.config ?? CFG,
        egress: over.egress ?? egressOf(false),
        ...(over.afterVerdicts ? { afterVerdicts: over.afterVerdicts } : {}),
      },
    };
    return aiPassProcessor(d);
  }

  /** Queue a judge run the way the worker does after a scan. */
  async function queue(
    over: { egress?: EgressOf; config?: JudgeConfig; workspaceId?: number; repoId?: number } = {},
  ) {
    const enqueued: number[] = [];
    const r = await queueJudgeAfterScan(
      {
        db,
        config: over.config ?? CFG,
        egress: over.egress ?? egressOf(false),
        enqueue: async ({ runId }) => {
          enqueued.push(runId);
        },
      },
      { workspaceId: over.workspaceId ?? WS, repoId: over.repoId ?? REPO },
    );
    return { ...r, enqueued };
  }

  it('queues one judge run after a scan when every routed model is local: on by default, bounded by time', async () => {
    await ruleHit();
    const first = await queue();
    expect(first).toMatchObject({ queued: true });
    expect(first.enqueued).toEqual([first.runId]);
    const run = await runOf(first.runId!);
    expect(run).toMatchObject({
      mode: 'judge',
      trigger: 'after_scan',
      budget: 'time',
      status: 'pending',
      requestedBy: null,
    });
    // One waiting run covers the next scan too.
    expect(await queue()).toMatchObject({ queued: false, code: 'already_queued' });
    // A person's pass is not blocked by it (its own one-active index).
    await db.insert(read.aiPassRuns).values({ workspaceId: WS, repoId: REPO, paths: ['src'] });
  });

  it('writes no run when there is nothing to judge, AI is off, or the server switch is off', async () => {
    expect(await queue()).toMatchObject({ queued: false, code: 'nothing_to_judge' });
    await ruleHit({ dimension: 'code_health' }); // not a judged dimension
    await ruleHit({ contextLines: null, contextStartLine: null }); // no stored code
    await ruleHit({ scannerKey: null, ruleId: null }); // not a rule hit
    await ruleHit({ status: 'dismissed', dismissReason: 'false_positive' });
    expect(await queue()).toMatchObject({ queued: false, code: 'nothing_to_judge' });
    await ruleHit();
    expect(await queue({ config: { ...CFG, enabled: false } })).toMatchObject({
      queued: false,
      code: 'disabled',
    });
    await db.insert(read.aiPassSettings).values({ workspaceId: WS, aiPaused: true });
    expect(await queue()).toMatchObject({ queued: false, code: 'ai_paused' });
    expect(
      await db.select().from(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, WS)),
    ).toHaveLength(0);
  });

  it('judges in risk order grouped by rule, stores each verdict with its citations, and sets verify_status', async () => {
    const low = await ruleHit({ ruleId: 'rule-a', effectiveRisk: '20.00', title: 'A low' });
    const top = await ruleHit({ ruleId: 'rule-b', effectiveRisk: '90.00', title: 'B top' });
    const mid = await ruleHit({ ruleId: 'rule-a', effectiveRisk: '60.00', title: 'A mid' });
    const perf = await ruleHit({
      ruleId: 'perf-1',
      dimension: 'performance',
      effectiveRisk: '10.00',
      title: 'P',
    });
    const slop = await ruleHit({
      ruleId: 'slop-1',
      dimension: 'slop',
      effectiveRisk: '5.00',
      title: 'S unsure',
    });
    const gw = scripted({
      verdictFor: (p) =>
        p.includes('A low')
          ? 'likely_false_positive'
          : p.includes('S unsure')
            ? 'needs_human'
            : 'real',
    });
    let repriced = 0;
    const { runId } = await queue();
    const result = await processor(gw, {
      afterVerdicts: async () => {
        repriced += 1;
      },
    })(job(runId!));
    expect(result.status).toBe('succeeded');

    // Order: rule-b (90), then rule-a (60, 20), then performance, then slop.
    const order = gw.prompts.map((p) => /(B top|A mid|A low|P\b|S unsure)/.exec(p)?.[1]);
    expect(order).toEqual(['B top', 'A mid', 'A low', 'P', 'S unsure']);

    const run = await runOf(runId!);
    const summary = (run.plan as { judge: JudgeSummary }).judge;
    expect(summary).toMatchObject({
      budget: 'time',
      candidates: 5,
      rules: 4,
      judged: 5,
      confirmed: 3,
      contradicted: 1,
      needs_human: 1,
      errors: 0,
      stopped: 'done',
    });
    expect(run.calls).toBe(5);
    expect((run.triageFunnel as { dismissed: number }).dismissed).toBe(0);
    expect(repriced).toBe(1);

    const [v] = await db
      .select()
      .from(read.aiTriageVerdicts)
      .where(eq(read.aiTriageVerdicts.findingId, top));
    expect(v).toMatchObject({
      verdict: 'real',
      aiPassRunId: runId,
      decision: null,
      connectionName: 'LM Studio',
    });
    expect(v!.citations[0]).toMatchObject({ file: 'src/routes/users.ts', line: 3 });
    expect(v!.citations[0]!.text).toContain('db.query');

    expect(await finding(top)).toMatchObject({
      verifyStatus: 'confirmed',
      verifiedByModel: 'scripted-model',
    });
    expect(await finding(mid)).toMatchObject({ verifyStatus: 'confirmed' });
    expect(await finding(perf)).toMatchObject({ verifyStatus: 'confirmed' });
    expect(await finding(low)).toMatchObject({ verifyStatus: 'contradicted' });
    expect((await finding(low)).verifyReason).toMatch(/likely false positive/);
    // needs_human leaves it unverified, with the reason.
    expect(await finding(slop)).toMatchObject({ verifyStatus: 'unverified' });
    expect((await finding(slop)).verifyReason).toMatch(/could not decide/);

    // Judged once: the next scan finds nothing left to judge.
    expect(await queue()).toMatchObject({ queued: false, code: 'nothing_to_judge' });
  });

  it('NEVER dismisses, resolves or suppresses: a contradicting verdict leaves the status as it was', async () => {
    const id = await ruleHit();
    const before = await finding(id);
    const { runId } = await queue();
    await processor(scripted({ verdictFor: () => 'likely_false_positive' }))(job(runId!));
    const after = await finding(id);
    expect(after.verifyStatus).toBe('contradicted');
    expect(after).toMatchObject({
      status: before.status,
      dismissReason: before.dismissReason,
      dedupKey: before.dedupKey,
    });
    expect(after.status).toBe('open');
    // No lifecycle event either: nothing about the finding was decided.
    expect(
      await db.select().from(read.findingEvents).where(eq(read.findingEvents.findingId, id)),
    ).toHaveLength(0);
  });

  it('records a model timeout on one finding and goes on to the next; that finding waits a day', async () => {
    const bad = await ruleHit({ ruleId: 'r1', effectiveRisk: '90.00', title: 'Times out' });
    const good = await ruleHit({ ruleId: 'r2', effectiveRisk: '50.00', title: 'Answers' });
    const { runId } = await queue();
    const result = await processor(scripted({ throwFor: (p) => p.includes('Times out') }))(
      job(runId!),
    );
    expect(result.status).toBe('succeeded');
    const summary = ((await runOf(runId!)).plan as { judge: JudgeSummary }).judge;
    expect(summary).toMatchObject({ judged: 1, errors: 1, failed_finding_ids: [bad] });
    expect(summary.error_samples[0]).toMatchObject({ finding_id: bad, rule: 'semgrep:r1' });
    expect(summary.error_samples[0]!.error).toMatch(/did not answer/);
    expect(await finding(good)).toMatchObject({ verifyStatus: 'confirmed' });
    expect(await finding(bad)).toMatchObject({ verifyStatus: 'unverified', status: 'open' });

    // The next run does not spend its budget on it again today.
    await ruleHit({ ruleId: 'r3', title: 'New hit' });
    const next = await queue();
    const gw = scripted();
    await processor(gw)(job(next.runId!));
    expect(gw.prompts.some((p) => p.includes('Times out'))).toBe(false);
    expect(gw.prompts).toHaveLength(1);
  });

  it('stops after repeated model errors and fails the run in words when nothing was judged', async () => {
    for (let i = 0; i < 7; i++) await ruleHit({ ruleId: `r${i}` });
    const { runId } = await queue();
    const result = await processor(scripted({ throwFor: () => true }))(job(runId!));
    expect(result.status).toBe('failed');
    const run = await runOf(runId!);
    expect(run.reasonCode).toBe('errors');
    expect(run.reason).toMatch(/failed 5 times in a row/);
    expect((run.plan as { judge: JudgeSummary }).judge).toMatchObject({
      errors: 5,
      not_reached: 2,
    });
  });

  it('local models are bounded by TIME: the run stops at its minutes, and the daily minutes are not on the call cap', async () => {
    for (let i = 0; i < 5; i++) await ruleHit({ ruleId: `t${i}`, effectiveRisk: String(90 - i) });
    let clock = new Date('2026-10-29T10:00:00Z').getTime();
    const now = () => new Date(clock);
    // Each model call takes 40 s of wall clock; the run may spend 1 minute.
    const gw = scripted({ onCall: () => (clock += 40_000) });
    const config = { ...CFG, scanMinutes: 1, minutesPerDay: 2 };
    const { runId } = await queue({ config });
    await processor(gw, { config, now })(job(runId!));
    const run = await runOf(runId!);
    expect(run.budget).toBe('time');
    expect(gw.prompts).toHaveLength(2);
    expect((run.plan as { judge: JudgeSummary }).judge).toMatchObject({
      stopped: 'time_budget',
      judged: 2,
      not_reached: 3,
    });
    expect(run.reasonCode).toBe('time_budget');
    // Local judge calls are NOT on the monthly call cap (decision 2).
    expect(await monthlyCallsUsed(db, WS, now())).toBe(0);
    // 80 s of a 2-minute day are spent: less than a minute is left.
    const e = await judgeEligibility({
      db,
      workspaceId: WS,
      repoId: REPO,
      config,
      now: now(),
      egress: egressOf(false),
    });
    expect(e).toMatchObject({ ok: false, code: 'time_budget_spent' });
    // The workspace's own setting overrides the server default.
    await db.insert(read.aiPassSettings).values({ workspaceId: WS, judgeMinutesPerDay: 60 });
    expect(
      await judgeEligibility({
        db,
        workspaceId: WS,
        repoId: REPO,
        config,
        now: now(),
        egress: egressOf(false),
      }),
    ).toMatchObject({ ok: true, budget: 'time', perDay: 60, minutes: 1 });
  });

  it('a hosted link keeps the W19-12 opt-in and the monthly call cap', async () => {
    await ruleHit();
    const hosted = egressOf(true);
    expect(await queue({ egress: hosted })).toMatchObject({ queued: false, code: 'not_opted_in' });
    expect(await queue({ egress: egressOf(true, { local_only: true }) })).toMatchObject({
      queued: false,
      code: 'local_only_forbids',
    });

    // An admin opted the repository in, acknowledging where source goes.
    await db.insert(read.aiPassSchedules).values({
      workspaceId: WS,
      repoId: REPO,
      enabled: true,
      egressDigest: 'old-digest',
      enabledAt: new Date(),
    });
    expect(await queue({ egress: hosted })).toMatchObject({
      queued: false,
      code: 'routing_changed',
    });
    await db
      .update(read.aiPassSchedules)
      .set({ egressDigest: 'hosted-digest' })
      .where(eq(read.aiPassSchedules.workspaceId, WS));

    await db.insert(read.aiPassSettings).values({ workspaceId: WS, monthlyCallCap: 0 });
    expect(await queue({ egress: hosted })).toMatchObject({ queued: false, code: 'cap_reached' });
    await db
      .update(read.aiPassSettings)
      .set({ monthlyCallCap: 300 })
      .where(eq(read.aiPassSettings.workspaceId, WS));

    const { runId, queued } = await queue({ egress: hosted });
    expect(queued).toBe(true);
    expect(await runOf(runId!)).toMatchObject({ budget: 'calls' });
    await processor(scripted(), { egress: hosted })(job(runId!));
    // Hosted calls ARE on the monthly cap.
    expect(await monthlyCallsUsed(db, WS, new Date())).toBe(1);
  });

  it('stays in its workspace (Law 5): another workspace’s rule hits are never judged', async () => {
    const mine = await ruleHit();
    const theirs = await ruleHit({
      workspaceId: OTHER,
      repoId: OTHER_REPO,
      scanRunId: otherScanRunId,
    });
    const { runId } = await queue();
    const gw = scripted();
    await processor(gw)(job(runId!));
    expect(gw.prompts).toHaveLength(1);
    expect(await finding(mine)).toMatchObject({ verifyStatus: 'confirmed' });
    expect(await finding(theirs)).toMatchObject({ verifyStatus: 'unverified' });
    expect(
      await db
        .select()
        .from(read.aiTriageVerdicts)
        .where(and(eq(read.aiTriageVerdicts.findingId, theirs))),
    ).toHaveLength(0);
    // A job naming this run under the other workspace finds nothing.
    expect((await processor(gw)(job(runId!, OTHER))).code).toBe('not_found');
  });
});
