import 'dotenv/config';
import type { Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import type {
  AnalysisGateway,
  CompleteOpts,
  CompleteResult,
  RoutingPolicy,
  T2Host,
} from '@repopulse/analysis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aiPassProcessor,
  JUDGE_SCAN_WAIT_MAX_MS,
  JUDGE_SCAN_WAIT_POLL_MS,
  type AiPassDeps,
  type AiPassJobData,
} from './ai-pass-processor.js';
import {
  judgeConfigFromEnv,
  judgeEligibility,
  judgeMsUsed,
  orderJudgeQueue,
  queueJudgeAfterScan,
  type EgressOf,
  type JudgeConfig,
  type JudgeSummary,
} from './ai-judge.js';
import { monthlyCallsUsed } from './ai-pass-scheduler.js';
import { TEST_PATH_PATTERN, isTestPath } from './code-kind.js';
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
    expect(judgeConfigFromEnv({})).toEqual({
      enabled: true,
      minutesPerDay: 240,
      scanMinutes: 30,
      fastMinConfidence: 0.8,
      batchSize: 4,
    });
  });
  it("reads 'off' and whole minutes, and ignores nonsense", () => {
    expect(
      judgeConfigFromEnv({
        AI_JUDGE: 'off',
        AI_JUDGE_MINUTES_PER_DAY: '60',
        AI_JUDGE_SCAN_MINUTES: 'lots',
        AI_JUDGE_FAST_MIN_CONFIDENCE: '0.6',
        AI_JUDGE_BATCH_SIZE: '1',
      }),
    ).toEqual({
      enabled: false,
      minutesPerDay: 60,
      scanMinutes: 30,
      fastMinConfidence: 0.6,
      batchSize: 1,
    });
    expect(judgeConfigFromEnv({ AI_JUDGE_MINUTES_PER_DAY: '5000' }).minutesPerDay).toBe(240);
    for (const bad of ['0', '1.5', 'high', '-1']) {
      expect(judgeConfigFromEnv({ AI_JUDGE_FAST_MIN_CONFIDENCE: bad }).fastMinConfidence).toBe(0.8);
    }
    // W22-14: 1-8 hits a call; anything else is the default.
    expect(judgeConfigFromEnv({ AI_JUDGE_BATCH_SIZE: '8' }).batchSize).toBe(8);
    for (const bad of ['0', '9', '2.5', 'many', '-1']) {
      expect(judgeConfigFromEnv({ AI_JUDGE_BATCH_SIZE: bad }).batchSize).toBe(4);
    }
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
    verdictFor?: (prompt: string, role: string) => string;
    throwFor?: (prompt: string, role: string) => boolean;
    onCall?: (role: string) => void;
    /** Extra answer fields (W22-03: impact on a performance hit). */
    extraFor?: (prompt: string) => Record<string, unknown>;
    /** W22-03 quick first look: the confidence (1-5) a role answers with. */
    confidenceFor?: (prompt: string, role: string) => number;
    /** W22-03: an answer that fails the checklist (not JSON) for a role. */
    garbleFor?: (prompt: string, role: string) => boolean;
    /** W22-14: in a batched answer, leave out the item for a hit (by its section). */
    omitFor?: (section: string, role: string) => boolean;
  } = {},
) {
  const prompts: string[] = [];
  /** The role of every call, in order. */
  const roles: string[] = [];
  /** W22-14: hits asked by each call (1 = a single-hit call) and the prompt version. */
  const hits: number[] = [];
  const versions: string[] = [];
  const answerFor = (text: string, role: string) => {
    const flagged = /Flagged lines: (\d+)-/.exec(text)?.[1] ?? '1';
    const line = new RegExp(`^\\s*${flagged}\\| (.*)$`, 'm').exec(text)?.[1] ?? '';
    const verdict = opts.verdictFor?.(text, role) ?? 'real';
    return {
      verdict,
      confidence: opts.confidenceFor?.(text, role) ?? 4,
      citations: [{ line: Number(flagged), quote: line.trim().slice(0, 30) }],
      rationale: `judged ${verdict} from the cited line`,
      vex_justification:
        verdict === 'likely_false_positive' ? 'inline_mitigations_already_exist' : null,
      vex_statement: verdict === 'likely_false_positive' ? 'validated upstream' : null,
      patch: null,
      ...(opts.extraFor?.(text) ?? {}),
    };
  };
  const gateway: AnalysisGateway = {
    async complete(prompt: string, o: CompleteOpts): Promise<CompleteResult> {
      const role = String(o.meta.role);
      prompts.push(prompt);
      roles.push(role);
      versions.push(o.meta.checklistVersion);
      opts.onCall?.(role);
      expect(['triage', 'triage_fast']).toContain(role);
      expect(o.meta.initiator).toBe('ai-judge');
      // W22-14: a batched prompt is answered with one item per hit section.
      const sections = prompt.split(/^## Hit (?=H\d+$)/m).slice(1);
      hits.push(Math.max(1, sections.length));
      if (opts.throwFor?.(prompt, role)) throw new Error('The model did not answer within 300 s');
      if (sections.length > 0) {
        const model = role === 'triage_fast' ? 'scripted-small' : 'scripted-model';
        const items = sections
          .filter((s) => !opts.omitFor?.(s, role))
          .map((s) => ({ hit: /^(H\d+)/.exec(s)![1], ...answerFor(s, role) }));
        return {
          text: JSON.stringify(items),
          model,
          tokensIn: 100,
          tokensOut: 20,
          costUsd: null,
          durationMs: 1,
          route: {
            role: role as 'triage',
            providerId: 1,
            providerName: 'LM Studio',
            model,
            linkIndex: 0,
            failedLinks: [],
          },
        };
      }
      const flagged = /Flagged lines: (\d+)-/.exec(prompt)?.[1] ?? '1';
      const line = new RegExp(`^\\s*${flagged}\\| (.*)$`, 'm').exec(prompt)?.[1] ?? '';
      const verdict = opts.verdictFor?.(prompt, role) ?? 'real';
      const model = role === 'triage_fast' ? 'scripted-small' : 'scripted-model';
      if (opts.garbleFor?.(prompt, role)) {
        return {
          text: 'I think it is fine.',
          model,
          tokensIn: 100,
          tokensOut: 5,
          costUsd: null,
          durationMs: 1,
        };
      }
      return {
        text: JSON.stringify({
          verdict,
          confidence: opts.confidenceFor?.(prompt, role) ?? 4,
          citations: [{ line: Number(flagged), quote: line.trim().slice(0, 30) }],
          rationale: `judged ${verdict} from the cited line`,
          vex_justification:
            verdict === 'likely_false_positive' ? 'inline_mitigations_already_exist' : null,
          vex_statement: verdict === 'likely_false_positive' ? 'validated upstream' : null,
          patch: null,
          ...(opts.extraFor?.(prompt) ?? {}),
        }),
        model,
        tokensIn: 100,
        tokensOut: 20,
        costUsd: null,
        durationMs: 1,
        route: {
          role: role as 'triage',
          providerId: 1,
          providerName: 'LM Studio',
          model,
          linkIndex: 0,
          failedLinks: [],
        },
      };
    },
    async health() {
      return { ok: true };
    },
  };
  return { gateway, prompts, roles, hits, versions };
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
      scansPending?: () => Promise<boolean>;
      requeue?: (data: AiPassJobData, delayMs: number) => Promise<void>;
      /** W22-03: the workspace's routing (a triage_fast chain turns the quick first look on). */
      routing?: RoutingPolicy;
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
        ...(over.routing ? { routing: over.routing } : {}),
      }),
      loadSources: async () => ({ ok: false, code: 'unused', reason: 'unused' }),
      ...(over.now ? { now: over.now } : {}),
      judge: {
        config: over.config ?? CFG,
        egress: over.egress ?? egressOf(false),
        ...(over.afterVerdicts ? { afterVerdicts: over.afterVerdicts } : {}),
        ...(over.scansPending ? { scansPending: over.scansPending } : {}),
        ...(over.requeue ? { requeue: over.requeue } : {}),
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

  it("waits while the repo's scans are still running, then judges once they are done", async () => {
    // Each scanner is its own job and queues the judge when it ends; on outline
    // the run started after the first one and judged the previous scan.
    await ruleHit();
    const { runId } = await queue();
    let pending = true;
    const requeued: number[] = [];
    const gw = scripted({ verdictFor: () => 'real' });
    const p = processor(gw, {
      scansPending: async () => pending,
      requeue: async (_data, delayMs) => {
        requeued.push(delayMs);
      },
    });
    expect(await p(job(runId!))).toMatchObject({ status: 'skipped', code: 'waiting_for_scans' });
    expect(requeued).toEqual([JUDGE_SCAN_WAIT_POLL_MS]);
    expect(await runOf(runId!)).toMatchObject({ status: 'pending' });
    expect(gw.prompts).toHaveLength(0);

    pending = false;
    expect((await p(job(runId!))).status).toBe('succeeded');
    expect(gw.prompts).toHaveLength(1);
    expect(requeued).toHaveLength(1);
  });

  it('stops waiting for scans after the cap and judges what is there', async () => {
    await ruleHit();
    const { runId } = await queue();
    const gw = scripted({ verdictFor: () => 'real' });
    const later = new Date(Date.now() + JUDGE_SCAN_WAIT_MAX_MS + 60_000);
    const result = await processor(gw, {
      now: () => later,
      scansPending: async () => true,
      requeue: async () => {
        throw new Error('should not wait again');
      },
    })(job(runId!));
    expect(result.status).not.toBe('skipped');
    expect(gw.prompts.length).toBeGreaterThan(0);
  });

  it('writes no run when there is nothing to judge, AI is off, or the server switch is off', async () => {
    expect(await queue()).toMatchObject({ queued: false, code: 'nothing_to_judge' });
    await ruleHit({ dimension: 'code_health' }); // not a judged dimension
    await ruleHit({ contextLines: null, contextStartLine: null }); // no stored code
    await ruleHit({ scannerKey: null, ruleId: null }); // not a rule hit
    await ruleHit({ status: 'dismissed', dismissReason: 'false_positive' });
    // W25-16: rule hits in test code are listed but never judged.
    await ruleHit({ file: 'src/routes/users.test.ts' });
    await ruleHit({ file: 'tests/test_users.py' });
    await ruleHit({ file: 'binding/binding_test.go' });
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

  // W22-03 (2026-10-29): on outline two copy-in-a-loop hits over small fixed
  // lists were confirmed and one got a fix drafted. A real performance hit now
  // says how much it matters; negligible is counted apart and stays confirmed.
  it("stores a performance hit's impact, counts real_but_negligible apart, and changes no status", async () => {
    const small = await ruleHit({
      ruleId: 'perf-copy',
      dimension: 'performance',
      effectiveRisk: '40.00',
      title: 'Copy over fixed list',
    });
    const big = await ruleHit({
      ruleId: 'perf-copy',
      dimension: 'performance',
      effectiveRisk: '30.00',
      title: 'Copy over rows',
    });
    const sast = await ruleHit({ effectiveRisk: '20.00', title: 'Injection' });
    const gw = scripted({
      extraFor: (p) =>
        p.includes('Copy over fixed list')
          ? { impact: 'negligible', impact_reason: 'line 2: the routes are a fixed list' }
          : p.includes('Copy over rows')
            ? { impact: 'material', impact_reason: 'line 3: rows from the database' }
            : { impact: 'negligible', impact_reason: 'not asked, so not kept' },
    });
    const { runId } = await queue();
    expect((await processor(gw)(job(runId!))).status).toBe('succeeded');

    // Asked of the performance hits only.
    const perfPrompts = gw.prompts.filter((p) => p.includes('Dimension: performance'));
    expect(perfPrompts).toHaveLength(2);
    for (const p of perfPrompts) expect(p).toContain('How much it matters');
    expect(gw.prompts.find((p) => p.includes('Injection'))).not.toContain('How much it matters');

    const summary = ((await runOf(runId!)).plan as { judge: JudgeSummary }).judge;
    expect(summary).toMatchObject({ judged: 3, confirmed: 2, real_but_negligible: 1 });

    const impactOf = async (id: number) =>
      (
        await db
          .select({ impact: read.aiTriageVerdicts.impact, why: read.aiTriageVerdicts.impactReason })
          .from(read.aiTriageVerdicts)
          .where(eq(read.aiTriageVerdicts.findingId, id))
      )[0]!;
    expect(await impactOf(small)).toEqual({
      impact: 'negligible',
      why: 'line 2: the routes are a fixed list',
    });
    expect((await impactOf(big)).impact).toBe('material');
    expect(await impactOf(sast)).toEqual({ impact: null, why: null });

    // Still confirmed, still open: the AI never suppresses.
    const f = await finding(small);
    expect(f).toMatchObject({ verifyStatus: 'confirmed', status: 'open' });
    expect(f.verifyReason).toMatch(/small or bounded input/);
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

  it('time spent waiting for a busy model is not charged to the run or the day (W25-02)', async () => {
    // 0.2.0 install: axum's judge took 71 minutes for two calls, its clock
    // running while scan reviews held the one-slot local model.
    for (let i = 0; i < 5; i++) await ruleHit({ ruleId: `q${i}`, effectiveRisk: String(90 - i) });
    let clock = new Date('2026-10-29T10:00:00Z').getTime();
    const now = () => new Date(clock);
    // Each call waits 60 s for the host's slot, then the model works 40 s.
    const inner = scripted({ onCall: () => (clock += 100_000) });
    const gw = {
      ...inner,
      gateway: {
        ...inner.gateway,
        complete: async (p: string, o: CompleteOpts) => ({
          ...(await inner.gateway.complete(p, o)),
          queuedMs: 60_000,
        }),
      },
    };
    const config = { ...CFG, scanMinutes: 1, minutesPerDay: 10 };
    const { runId } = await queue({ config });
    await processor(gw, { config, now })(job(runId!));
    const run = await runOf(runId!);
    // Charged on wall clock alone it would have stopped after ONE call.
    expect(inner.prompts).toHaveLength(2);
    const summary = (run.plan as { judge: JudgeSummary }).judge;
    expect(summary).toMatchObject({ stopped: 'time_budget', judged: 2, queued_ms: 120_000 });
    expect(run.reason).toMatch(/not counting 2 min waiting for the model/);
    // The day is charged the model's 80 s, not the 200 s of wall clock.
    expect(await judgeMsUsed(db, WS, now())).toBe(80_000);
  });

  it('a run waiting longer than the allowance is not closed as stalled (W25-02)', async () => {
    await ruleHit();
    const t0 = new Date('2026-10-29T10:00:00Z');
    const first = await queueJudgeAfterScan(
      { db, config: CFG, egress: egressOf(false), now: () => t0, enqueue: async () => {} },
      { workspaceId: WS, repoId: REPO },
    );
    expect(first.queued).toBe(true);
    // 31 + 60 minutes later: the old cutoff (scan minutes + 60) closed it.
    const later = new Date(t0.getTime() + 91 * 60_000);
    const again = await queueJudgeAfterScan(
      { db, config: CFG, egress: egressOf(false), now: () => later, enqueue: async () => {} },
      { workspaceId: WS, repoId: REPO },
    );
    expect(again).toMatchObject({ queued: false, code: 'already_queued' });
    expect((await runOf(first.runId!)).status).toBe('pending');
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

  // W22-03 (2026-10-29): a quick first look by a smaller model, confirmed by
  // the main one. Measured on outline: about 7 minutes per verdict on a local
  // 27B model, while most graded rule hits are false positives.
  describe('the quick first look (optional triage_fast route)', () => {
    const FAST: RoutingPolicy = {
      localOnly: false,
      chains: {
        triage_fast: [
          {
            host: {
              baseUrl: 'http://10.0.0.6:1234/v1',
              modelSlot: 'scripted-small',
              contextWindow: 16384,
            } as T2Host,
            providerName: 'LM Studio small',
          },
        ],
      },
    };
    const verdictsOf = async (id: number) =>
      db.select().from(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.findingId, id));

    it('with no triage_fast chain, judges exactly as before: one triage call per hit', async () => {
      const a = await ruleHit({ ruleId: 'n1', effectiveRisk: '90.00', title: 'N fp' });
      const b = await ruleHit({ ruleId: 'n2', effectiveRisk: '80.00', title: 'N real' });
      const c = await ruleHit({ ruleId: 'n3', effectiveRisk: '70.00', title: 'N unsure' });
      const gw = scripted({
        verdictFor: (p) =>
          p.includes('N fp')
            ? 'likely_false_positive'
            : p.includes('N unsure')
              ? 'needs_human'
              : 'real',
        confidenceFor: () => 5,
      });
      const { runId } = await queue();
      await processor(gw)(job(runId!));
      expect(gw.roles).toEqual(['triage', 'triage', 'triage']);
      const run = await runOf(runId!);
      expect(run.calls).toBe(3);
      expect((run.plan as { judge: JudgeSummary }).judge).toMatchObject({
        judged: 3,
        confirmed: 1,
        contradicted: 1,
        needs_human: 1,
        fast_pass: false,
        fast_cleared: 0,
        escalated: 0,
        fast_errors: 0,
        fast_ms: 0,
        fast_vs_full: {},
      });
      // W22-14: no quick first look, so nothing kept beside the verdict.
      for (const id of [a, b, c]) expect((await verdictsOf(id))[0]!.fastPass).toBeNull();
      expect((await verdictsOf(a))[0]).toMatchObject({ pass: 'full', model: 'scripted-model' });
      expect(await finding(a)).toMatchObject({ verifyStatus: 'contradicted', status: 'open' });
      expect((await finding(a)).verifyReason).not.toMatch(/quick first look/);
      expect(await finding(b)).toMatchObject({ verifyStatus: 'confirmed' });
      expect(await finding(c)).toMatchObject({ verifyStatus: 'unverified' });
    });

    it('a confident likely false positive stops at the quick first look; everything else goes on to triage', async () => {
      const cleared = await ruleHit({ ruleId: 'f1', effectiveRisk: '90.00', title: 'F clear' });
      const real = await ruleHit({ ruleId: 'f2', effectiveRisk: '80.00', title: 'F real' });
      const unsure = await ruleHit({ ruleId: 'f3', effectiveRisk: '70.00', title: 'F unsure' });
      const shaky = await ruleHit({ ruleId: 'f4', effectiveRisk: '60.00', title: 'F shaky' });
      const garbled = await ruleHit({ ruleId: 'f5', effectiveRisk: '50.00', title: 'F garbled' });
      const gw = scripted({
        // The small model's answers; the main model calls them all real.
        verdictFor: (p, role) =>
          role !== 'triage_fast'
            ? 'real'
            : p.includes('F real')
              ? 'real'
              : p.includes('F unsure')
                ? 'needs_human'
                : 'likely_false_positive',
        // 'F shaky' is a false positive at 3 of 5: under the 0.8 default.
        confidenceFor: (p, role) => (role === 'triage_fast' && p.includes('F shaky') ? 3 : 5),
        garbleFor: (p, role) => role === 'triage_fast' && p.includes('F garbled'),
      });
      const { runId } = await queue();
      expect((await processor(gw, { routing: FAST })(job(runId!))).status).toBe('succeeded');

      // F clear: 1 fast call. F real / unsure / shaky: fast then triage.
      // F garbled: 2 fast calls (a corrective retry), then triage.
      expect(gw.roles).toEqual([
        'triage_fast',
        'triage_fast',
        'triage',
        'triage_fast',
        'triage',
        'triage_fast',
        'triage',
        'triage_fast',
        'triage_fast',
        'triage',
      ]);
      const run = await runOf(runId!);
      expect(run.calls).toBe(10);
      expect((run.plan as { judge: JudgeSummary }).judge).toMatchObject({
        judged: 5,
        contradicted: 1,
        confirmed: 4,
        rejected: 0,
        fast_pass: true,
        fast_cleared: 1,
        escalated: 4,
        fast_errors: 0,
        stopped: 'done',
        // W22-14: escalations where both answered (F garbled's fast answer was rejected).
        fast_vs_full: {
          'real->real': 1,
          'needs_human->real': 1,
          'likely_false_positive->real': 1,
        },
      });

      // The fast verdict is stored as the verdict, and says so; status untouched.
      expect(await verdictsOf(cleared)).toHaveLength(1);
      expect((await verdictsOf(cleared))[0]).toMatchObject({
        verdict: 'likely_false_positive',
        pass: 'fast',
        model: 'scripted-small',
        fastPass: null,
      });
      const c = await finding(cleared);
      expect(c).toMatchObject({ verifyStatus: 'contradicted', status: 'open' });
      expect(c.verifyReason).toMatch(/^On a quick first look \(a smaller, faster model\)/);
      // Escalated: one stored verdict each, the main model's.
      for (const id of [real, unsure, shaky, garbled]) {
        const vs = await verdictsOf(id);
        expect(vs).toHaveLength(1);
        expect(vs[0]).toMatchObject({ verdict: 'real', pass: 'full', model: 'scripted-model' });
        expect(await finding(id)).toMatchObject({ verifyStatus: 'confirmed', status: 'open' });
      }
      // W22-14: each escalation keeps the quick first look's answer and why it escalated.
      const fastOf = async (id: number) => (await verdictsOf(id))[0]!.fastPass;
      expect(await fastOf(real)).toMatchObject({
        verdict: 'real',
        confidence: 5,
        reason: 'not_false_positive',
        model: 'scripted-small',
      });
      expect(await fastOf(unsure)).toMatchObject({
        verdict: 'needs_human',
        confidence: 5,
        reason: 'not_false_positive',
      });
      expect(await fastOf(shaky)).toMatchObject({
        verdict: 'likely_false_positive',
        confidence: 3,
        reason: 'low_confidence',
        model: 'scripted-small',
      });
      expect(await fastOf(garbled)).toMatchObject({
        verdict: null,
        confidence: null,
        reason: 'rejected',
        model: null,
      });
      expect(typeof (await fastOf(shaky))!.ms).toBe('number');
    });

    it('a quick-first-look provider error escalates to triage, and is counted apart', async () => {
      const id = await ruleHit({ ruleId: 'e1', title: 'E hit' });
      const gw = scripted({
        throwFor: (_p, role) => role === 'triage_fast',
        verdictFor: () => 'likely_false_positive',
      });
      const { runId } = await queue();
      await processor(gw, { routing: FAST })(job(runId!));
      expect(gw.roles).toEqual(['triage_fast', 'triage']);
      const run = await runOf(runId!);
      expect(run.calls).toBe(2);
      const summary = (run.plan as { judge: JudgeSummary }).judge;
      expect(summary).toMatchObject({
        judged: 1,
        contradicted: 1,
        errors: 0,
        failed_finding_ids: [],
        fast_errors: 1,
        escalated: 1,
        fast_cleared: 0,
        // W22-14: no fast answer, so nothing to compare.
        fast_vs_full: {},
      });
      expect(summary.error_samples[0]!.error).toMatch(/^quick first look: .*did not answer/);
      expect((await verdictsOf(id))[0]).toMatchObject({
        pass: 'full',
        model: 'scripted-model',
        fastPass: { verdict: null, confidence: null, reason: 'provider_error', model: null },
      });
      expect((await finding(id)).verifyReason).not.toMatch(/quick first look/);
    });

    it('both passes spend the same run minutes: no triage call once the fast pass used them up', async () => {
      for (let i = 0; i < 2; i++) await ruleHit({ ruleId: `b${i}`, effectiveRisk: String(90 - i) });
      let clock = new Date('2026-10-29T10:00:00Z').getTime();
      const now = () => new Date(clock);
      // The small model takes 70 s; the run may spend 1 minute.
      const gw = scripted({
        onCall: (role) => (clock += role === 'triage_fast' ? 70_000 : 10_000),
      });
      const config = { ...CFG, scanMinutes: 1 };
      const { runId } = await queue({ config });
      await processor(gw, { config, now, routing: FAST })(job(runId!));
      expect(gw.roles).toEqual(['triage_fast']);
      const run = await runOf(runId!);
      expect(run.reasonCode).toBe('time_budget');
      expect((run.plan as { judge: JudgeSummary }).judge).toMatchObject({
        stopped: 'time_budget',
        judged: 0,
        escalated: 1,
        not_reached: 2,
        fast_ms: 70_000,
        full_ms: 0,
      });
    });

    it('the threshold is a setting: at 0.6 a 3-of-5 likely false positive stands', async () => {
      const id = await ruleHit({ ruleId: 't1', title: 'T hit' });
      const gw = scripted({
        verdictFor: () => 'likely_false_positive',
        confidenceFor: () => 3,
      });
      const config = { ...CFG, fastMinConfidence: 0.6 };
      const { runId } = await queue({ config });
      await processor(gw, { config, routing: FAST })(job(runId!));
      expect(gw.roles).toEqual(['triage_fast']);
      expect((await verdictsOf(id))[0]).toMatchObject({ pass: 'fast' });
    });
  });

  // W22-14: several hits of one rule per call, each with its own verdict.
  describe('several hits of one rule per call (AI_JUDGE_BATCH_SIZE)', () => {
    const FAST_ROUTE: RoutingPolicy = {
      localOnly: false,
      chains: {
        triage_fast: [
          {
            host: {
              baseUrl: 'http://10.0.0.6:1234/v1',
              modelSlot: 'scripted-small',
              contextWindow: 16384,
            } as T2Host,
            providerName: 'LM Studio small',
          },
        ],
      },
    };
    const verdictsOf = async (id: number) =>
      db.select().from(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.findingId, id));
    const judgeOf = async (runId: number) =>
      ((await runOf(runId)).plan as { judge: JudgeSummary }).judge;

    it('batch size 1 makes exactly the calls of one hit per call', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await ruleHit({ effectiveRisk: String(90 - i), title: `One ${i}` }));
      }
      const config = { ...CFG, batchSize: 1 };
      const gw = scripted();
      const { runId } = await queue({ config });
      await processor(gw, { config })(job(runId!));
      expect(gw.roles).toEqual(['triage', 'triage', 'triage']);
      expect(gw.hits).toEqual([1, 1, 1]);
      expect(gw.versions).toEqual(['triage.v1', 'triage.v1', 'triage.v1']);
      gw.prompts.forEach((p, i) => {
        expect(p).toContain('## The finding');
        expect(p).toContain(`Title: One ${i}`);
        expect(p).not.toMatch(/^## Hit /m);
      });
      // The same three calls as a server with no batch setting at all.
      await clear();
      for (let i = 0; i < 3; i++)
        await ruleHit({ effectiveRisk: String(90 - i), title: `One ${i}` });
      const before = scripted();
      const q2 = await queue();
      await processor(before)(job(q2.runId!));
      expect(before.prompts).toEqual(gw.prompts);
      const judge = await judgeOf(q2.runId!);
      expect(judge).toMatchObject({ judged: 3, batch_size: 1, batch_retried: 0 });
      expect(judge.batches.map((b) => [b.pass, b.hits])).toEqual([
        ['full', 1],
        ['full', 1],
        ['full', 1],
      ]);
    });

    it('batch size 4: 6 hits of one rule and 2 of another make 3 calls (4, 2, 2) and 8 verdicts', async () => {
      const x: number[] = [];
      const y: number[] = [];
      for (let i = 0; i < 6; i++) {
        x.push(await ruleHit({ ruleId: 'rule-x', effectiveRisk: String(90 - i), title: `X ${i}` }));
      }
      for (let i = 0; i < 2; i++) {
        y.push(await ruleHit({ ruleId: 'rule-y', effectiveRisk: String(40 - i), title: `Y ${i}` }));
      }
      const config = { ...CFG, batchSize: 4 };
      const gw = scripted({
        verdictFor: (s) =>
          s.includes('Title: X 1')
            ? 'likely_false_positive'
            : s.includes('Title: Y')
              ? 'needs_human'
              : 'real',
      });
      const { runId } = await queue({ config });
      await processor(gw, { config })(job(runId!));
      expect(gw.hits).toEqual([4, 2, 2]);
      expect(gw.versions).toEqual(['triage.v1+batch', 'triage.v1+batch', 'triage.v1+batch']);
      // Each call holds one rule only.
      expect(gw.prompts[0]).toContain('Rule: rule-x');
      expect(gw.prompts[2]).toContain('Rule: rule-y');
      expect(gw.prompts[2]).not.toContain('Rule: rule-x');
      const run = await runOf(runId!);
      expect(run.calls).toBe(3);
      const judge = await judgeOf(runId!);
      expect(judge).toMatchObject({
        judged: 8,
        confirmed: 5,
        contradicted: 1,
        needs_human: 2,
        rejected: 0,
        batch_size: 4,
        batch_retried: 0,
        stopped: 'done',
      });
      expect(judge.batches.map((b) => [b.pass, b.hits, b.rejected])).toEqual([
        ['full', 4, 0],
        ['full', 2, 0],
        ['full', 2, 0],
      ]);
      for (const b of judge.batches) expect(typeof b.ms).toBe('number');
      expect(run.triageFunnel).toMatchObject({ candidates: 8, triaged: 8, accepted: 8 });
      // Each hit its own verdict, from its own lines; the version says a batch asked.
      for (const id of [...x, ...y]) {
        const vs = await verdictsOf(id);
        expect(vs).toHaveLength(1);
        expect(vs[0]).toMatchObject({ checklistVersion: 'triage.v1+batch', pass: 'full' });
        expect(vs[0]!.citations).toEqual([
          expect.objectContaining({ file: 'src/routes/users.ts', line: 3 }),
        ]);
      }
      expect((await verdictsOf(x[1]!))[0]!.verdict).toBe('likely_false_positive');
      // Same verify mapping as one hit per call; no status moves.
      expect(await finding(x[1]!)).toMatchObject({ verifyStatus: 'contradicted', status: 'open' });
      expect(await finding(x[0]!)).toMatchObject({ verifyStatus: 'confirmed', status: 'open' });
      expect(await finding(y[0]!)).toMatchObject({ verifyStatus: 'unverified', status: 'open' });
    });

    it('a hit missing from a batched answer is asked again alone; the others stand', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await ruleHit({ effectiveRisk: String(90 - i), title: `M ${i}` }));
      }
      const config = { ...CFG, batchSize: 4 };
      // The batched answer leaves out "M 1"; asked alone, it is answered.
      const gw = scripted({ omitFor: (s) => s.includes('Title: M 1') });
      const { runId } = await queue({ config });
      await processor(gw, { config })(job(runId!));
      expect(gw.hits).toEqual([3, 1]);
      expect(gw.versions).toEqual(['triage.v1+batch', 'triage.v1']);
      expect(gw.prompts[1]).toContain('Title: M 1');
      const judge = await judgeOf(runId!);
      expect(judge).toMatchObject({ judged: 3, rejected: 0, batch_retried: 1 });
      expect(judge.batches.map((b) => [b.hits, b.rejected])).toEqual([
        [3, 1],
        [1, 0],
      ]);
      expect((await verdictsOf(ids[1]!))[0]!.checklistVersion).toBe('triage.v1');
      expect((await verdictsOf(ids[0]!))[0]!.checklistVersion).toBe('triage.v1+batch');
    });

    it('with the quick first look: the fast pass batches too, and only the right hits escalate (re-batched)', async () => {
      const clear1 = await ruleHit({ effectiveRisk: '90.00', title: 'Q clear' });
      const real = await ruleHit({ effectiveRisk: '80.00', title: 'Q real' });
      const shaky = await ruleHit({ effectiveRisk: '70.00', title: 'Q shaky' });
      const lost = await ruleHit({ effectiveRisk: '60.00', title: 'Q lost' });
      const clear2 = await ruleHit({ effectiveRisk: '50.00', title: 'Q also clear' });
      const config = { ...CFG, batchSize: 4 };
      const gw = scripted({
        verdictFor: (s, role) =>
          role !== 'triage_fast' ? 'real' : s.includes('Q real') ? 'real' : 'likely_false_positive',
        confidenceFor: (s, role) => (role === 'triage_fast' && s.includes('Q shaky') ? 3 : 5),
        // The small model's batched answer leaves "Q lost" out.
        omitFor: (s, role) => role === 'triage_fast' && s.includes('Q lost'),
      });
      const { runId } = await queue({ config });
      await processor(gw, { config, routing: FAST_ROUTE })(job(runId!));
      // Fast: a batch of 4 then the 5th alone (a single-hit call). The three
      // escalations of the first batch go to the main model together.
      expect(gw.roles).toEqual(['triage_fast', 'triage', 'triage_fast']);
      expect(gw.hits).toEqual([4, 3, 1]);
      const judge = await judgeOf(runId!);
      expect(judge).toMatchObject({
        judged: 5,
        fast_cleared: 2,
        escalated: 3,
        contradicted: 2,
        confirmed: 3,
        fast_vs_full: { 'real->real': 1, 'likely_false_positive->real': 1 },
      });
      expect(judge.batches.map((b) => [b.pass, b.hits, b.rejected])).toEqual([
        ['fast', 4, 1],
        ['full', 3, 0],
        ['fast', 1, 0],
      ]);
      for (const id of [clear1, clear2]) {
        expect((await verdictsOf(id))[0]).toMatchObject({
          pass: 'fast',
          verdict: 'likely_false_positive',
          fastPass: null,
        });
      }
      expect((await verdictsOf(clear1))[0]!.checklistVersion).toBe('triage.v1+batch');
      expect((await verdictsOf(clear2))[0]!.checklistVersion).toBe('triage.v1');
      // Each escalation keeps its own fast answer, stored per hit.
      const fastOf = async (id: number) => (await verdictsOf(id))[0]!;
      expect(await fastOf(real)).toMatchObject({
        pass: 'full',
        verdict: 'real',
        fastPass: { verdict: 'real', reason: 'not_false_positive', model: 'scripted-small' },
      });
      expect(await fastOf(shaky)).toMatchObject({
        pass: 'full',
        fastPass: { verdict: 'likely_false_positive', confidence: 3, reason: 'low_confidence' },
      });
      expect(await fastOf(lost)).toMatchObject({
        pass: 'full',
        fastPass: { verdict: null, reason: 'rejected', model: null },
      });
      expect(typeof (await fastOf(shaky)).fastPass!.ms).toBe('number');
      expect(await finding(clear1)).toMatchObject({ verifyStatus: 'contradicted', status: 'open' });
      expect(await finding(real)).toMatchObject({ verifyStatus: 'confirmed', status: 'open' });
    });

    it('the deadline is checked between batches: a batch that would start after it does not start', async () => {
      for (let i = 0; i < 5; i++) await ruleHit({ effectiveRisk: String(90 - i), title: `D ${i}` });
      let clock = new Date('2026-10-29T10:00:00Z').getTime();
      const now = () => new Date(clock);
      // Each call takes 40 s; the run may spend 1 minute.
      const gw = scripted({ onCall: () => (clock += 40_000) });
      const config = { ...CFG, scanMinutes: 1, batchSize: 2 };
      const { runId } = await queue({ config });
      await processor(gw, { config, now })(job(runId!));
      // 0 s: batch of 2; 40 s: batch of 2; 80 s: past the minute, no third call.
      expect(gw.hits).toEqual([2, 2]);
      const run = await runOf(runId!);
      expect(run.reasonCode).toBe('time_budget');
      expect(await judgeOf(runId!)).toMatchObject({
        stopped: 'time_budget',
        judged: 4,
        not_reached: 1,
        full_ms: 80_000,
      });
    });
  });

  it('W25-16: Postgres reads the test pattern exactly as the worker does', async () => {
    const paths = [
      'context_test.go',
      'src/a.test.ts',
      'web/a.spec.tsx',
      'tests/test_api.py',
      'conftest.py',
      'src/test/java/FooTest.java',
      'spec/models/user_spec.rb',
      'test_helpers.go',
      'internal/testdata/x.go',
      'context.go',
      'latest.go',
      'contest.py',
      'src/Testimonial.tsx',
      'saleor/order/models.py',
    ];
    const rows = await db.execute<{ p: string; t: boolean }>(
      sql`select p, p ~ ${TEST_PATH_PATTERN} as t from unnest(${sql.raw(
        `array[${paths.map((p) => `'${p}'`).join(',')}]`,
      )}::text[]) as p`,
    );
    const pg = Object.fromEntries([...rows].map((r) => [r.p, r.t]));
    for (const p of paths) expect(pg[p], p).toBe(isTestPath(p));
    expect(paths.filter(isTestPath)).toHaveLength(9);
  });
});
