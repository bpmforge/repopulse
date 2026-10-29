import 'dotenv/config';
import type { Job } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import type { AnalysisGateway, CompleteOpts, CompleteResult, T2Host } from '@repopulse/analysis';
import type { ForgeProvider } from '@repopulse/forge';
import {
  hitDedupKey,
  runPatchDraft,
  type FileRuleRunner,
  type PatchDraftDeps,
  type RuleHit,
} from '@repopulse/security';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiPassProcessor, type AiPassDeps, type AiPassJobData } from './ai-pass-processor.js';
import {
  queueJudgeAfterScan,
  type EgressOf,
  type JudgeConfig,
  type JudgeSummary,
} from './ai-judge.js';
import { fixConfigFor, pickFixTargets, type FixConfig, type FixSummary } from './ai-fix.js';
import type { PassEgress } from '../lib/ai-pass-egress.js';

// W22-09. After judging, verified fixes are drafted for the top confirmed
// findings within the judge's time budget; a draft the re-scan rejects is
// recorded with its reason and never counts as a fix; a draft that could not
// be made is recorded and the loop goes on. The real draft-and-verify job
// (run.ts) runs here with a stub model, a read-only stub forge and a stub rule
// runner, so "verified" and "rejected" are the job's own verdicts.

describe('fixConfigFor', () => {
  it('follows the judge switch and drafts at most five a run', () => {
    expect(fixConfigFor({ enabled: true })).toEqual({ enabled: true, top: 5 });
    expect(fixConfigFor({ enabled: false })).toEqual({ enabled: false, top: 5 });
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const SOURCE = 'function run(cmd) {\n  return eval(cmd);\n}\n\nmodule.exports = { run };\n';
const SHA = 'b'.repeat(40);

function evalHits(file: string, source: string): RuleHit[] {
  return source.split('\n').flatMap((t, i) =>
    t.includes('eval(') || t.includes('innerHTML')
      ? [
          {
            scannerKey: 'semgrep',
            ruleId: t.includes('eval(') ? 'bpm-eval' : 'bpm-inner-html',
            dimension: 'sast',
            file,
            lineStart: i + 1,
            evidenceQuote: `${file}:${i + 1} — ${t.includes('eval(') ? 'bpm-eval' : 'bpm-inner-html'}`,
            title: 'stub',
          },
        ]
      : [],
  );
}

const runner: FileRuleRunner = {
  key: 'stub_pack',
  scannerKeys: ['semgrep'],
  async run(input) {
    return { status: 'succeeded', hits: evalHits(input.file, input.source) };
  },
};

/** A diff for `file` that clears the eval (good) or swaps it for innerHTML (a new finding). */
function diffFor(file: string, good: boolean): string {
  return JSON.stringify({
    diff: [
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1,3 +1,3 @@',
      ' function run(cmd) {',
      '-  return eval(cmd);',
      good ? '+  return JSON.parse(cmd);' : '+  return document.body.innerHTML = cmd;',
      ' }',
    ].join('\n'),
  });
}

/** The forge members the patch path may touch: reads only (D9a). */
function readOnlyForge(touched: string[]): ForgeProvider {
  const allowed = new Set(['kind', 'capabilities', 'getFileContent']);
  const impl: Partial<ForgeProvider> = {
    kind: 'github',
    capabilities: { supportsTarball: false } as ForgeProvider['capabilities'],
    async getFileContent(_ctx, _repo, filePath, ref) {
      return { path: filePath, ref, sizeBytes: SOURCE.length, content: SOURCE, truncated: false };
    },
  };
  return new Proxy(impl as ForgeProvider, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') {
        touched.push(prop);
        if (!allowed.has(prop) && prop !== 'then') {
          throw new Error(`forge member "${prop}" is not permitted on the patch path (D9a)`);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Egress per role: `patchLeaves` puts the patch role on a hosted link. */
const egressOf =
  (o: { triageLeaves?: boolean; patchLeaves?: boolean; localOnly?: boolean } = {}): EgressOf =>
  async (_db, _ws, roles) => {
    const asks = roles ?? [];
    const leaves = asks.includes('patch') ? !!o.patchLeaves : !!o.triageLeaves;
    const dest: PassEgress['destinations'] = [
      {
        provider_id: leaves ? 2 : 1,
        provider_name: leaves ? 'Hosted' : 'LM Studio',
        host: leaves ? 'api.example.com' : '10.0.0.5',
        leaves_network: leaves,
        roles: [...asks],
      },
    ];
    return {
      local_only: !!o.localOnly,
      destinations: dest,
      leaves_network: leaves,
      digest: leaves ? 'hosted-digest' : 'local-digest',
      sentence: 'test',
    };
  };

/**
 * One scripted model for both roles: the judge's checklist answer (by the
 * finding's title) and the patch draft (by the file in the prompt).
 */
function scripted(
  o: {
    verdictFor?: (prompt: string) => string;
    goodFix?: (prompt: string) => boolean;
    patchThrows?: (prompt: string) => boolean;
    onCall?: (role: string | undefined) => void;
  } = {},
) {
  const calls: { role: string | undefined; prompt: string; initiator: string }[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt: string, opts: CompleteOpts): Promise<CompleteResult> {
      calls.push({ role: opts.meta.role, prompt, initiator: opts.meta.initiator });
      o.onCall?.(opts.meta.role);
      const base = {
        model: 'scripted-model',
        tokensIn: 10,
        tokensOut: 5,
        costUsd: null,
        durationMs: 1,
      };
      if (opts.meta.role === 'patch') {
        if (o.patchThrows?.(prompt)) throw new Error('The model did not answer within 300 s');
        const file = /(src\/[a-z0-9-]+\.js)/.exec(prompt)?.[1] ?? 'src/run.js';
        return { ...base, text: diffFor(file, o.goodFix?.(prompt) ?? true) };
      }
      const flagged = /Flagged lines: (\d+)-/.exec(prompt)?.[1] ?? '1';
      const line = new RegExp(`^\\s*${flagged}\\| (.*)$`, 'm').exec(prompt)?.[1] ?? '';
      const verdict = o.verdictFor?.(prompt) ?? 'real';
      return {
        ...base,
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
      };
    },
    async health() {
      return { ok: true };
    },
  };
  return { gateway, calls };
}

describeIfLiveInfra('verified fixes after judging (W22-09)', () => {
  const db = createDb(databaseUrl as string);
  let WS = 0;
  let OTHER = 0;
  let REPO = 0;
  let OTHER_REPO = 0;
  const scanRuns: number[] = [];
  const scanRunOf = new Map<number, number>();
  const connections: number[] = [];
  let root = '';
  const CFG: JudgeConfig = { enabled: true, minutesPerDay: 240, scanMinutes: 30 };
  const FIX: FixConfig = { enabled: true, top: 5 };

  async function clear() {
    for (const w of [WS, OTHER]) {
      if (!w) continue;
      await db.delete(read.verifiedPatches).where(eq(read.verifiedPatches.workspaceId, w));
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
    const enc = credentials.encryptCredential('w22-09-fixture', Buffer.alloc(32, 7));
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
        org: 'w22-09',
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
        commitSha: SHA,
        trigger: 'manual',
        status: 'succeeded',
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(),
      })
      .returning({ id: security.scanRuns.id });
    scanRuns.push(sr!.id);
    scanRunOf.set(repo!.id, sr!.id);
    return repo!.id;
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rp-w22-09-'));
    WS = await workspace('w22-09-ws');
    OTHER = await workspace('w22-09-other');
    await clear();
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w22-09@example.test',
        login: 'w22-09',
        email: 'w22-09@example.test',
      })
      .onConflictDoNothing();
    const userId = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w22-09@example.test'))
        .limit(1)
    )[0]!.id;
    REPO = await repoIn(WS, `w22-09-repo-${Date.now()}`, userId);
    OTHER_REPO = await repoIn(OTHER, `w22-09-other-${Date.now()}`, userId);
  });
  afterAll(async () => {
    await clear();
    await db.delete(security.scanRuns).where(inArray(security.scanRuns.id, scanRuns));
    await db.delete(core.repos).where(inArray(core.repos.id, [REPO, OTHER_REPO]));
    await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.id, connections));
    await db.$client.end();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(clear);

  /**
   * An open eval() hit in `file`. `confirmed` marks it as the judge would have
   * (and stores no code context, so nothing is left to judge); otherwise it
   * carries context and waits for the judge.
   */
  async function evalHit(
    file: string,
    o: {
      confirmed?: boolean;
      risk?: string;
      ws?: number;
      repo?: number;
      ruleId?: string;
      scannerKey?: string;
    } = {},
  ) {
    const hit = evalHits(file, SOURCE)[0]!;
    const [f] = await db
      .insert(read.findings)
      .values({
        workspaceId: o.ws ?? WS,
        repoId: o.repo ?? REPO,
        scanRunId: scanRunOf.get(o.repo ?? REPO)!,
        dimension: 'sast',
        severity: 4,
        confidence: 4,
        title: `eval of input in ${file}`,
        scannerKey: o.scannerKey ?? 'semgrep',
        ruleId: o.ruleId ?? 'bpm-eval',
        file,
        lineStart: 2,
        lineEnd: 2,
        evidence: hit.evidenceQuote,
        recommendation: 'Do not eval input.',
        tier: 1,
        dedupKey: hitDedupKey({ ...hit, ...(o.ruleId ? { ruleId: o.ruleId } : {}) }),
        status: 'open',
        effectiveRisk: o.risk ?? '50.00',
        ...(o.confirmed
          ? { verifyStatus: 'confirmed', verifyReason: 'The AI judged this rule hit real.' }
          : { contextLines: SOURCE, contextStartLine: 1 }),
      })
      .returning({ id: read.findings.id });
    return f!.id;
  }

  const runOf = async (id: number) =>
    (await db.select().from(read.aiPassRuns).where(eq(read.aiPassRuns.id, id)))[0]!;
  const patchesOf = async (findingId: number) =>
    db.select().from(read.verifiedPatches).where(eq(read.verifiedPatches.findingId, findingId));
  const job = (runId: number, workspaceId = WS) =>
    ({ data: { workspaceId, runId } }) as Job<AiPassJobData>;

  function processor(
    gw: ReturnType<typeof scripted>,
    over: {
      egress?: EgressOf;
      now?: () => Date;
      fix?: FixConfig;
      touched?: string[];
      forgeThrows?: boolean;
      config?: JudgeConfig;
    } = {},
  ) {
    const touched = over.touched ?? [];
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
        egress: over.egress ?? egressOf(),
        fixes: {
          config: over.fix ?? FIX,
          egress: over.egress ?? egressOf(),
          forgeFor: async () => {
            if (over.forgeThrows) throw new Error('credential will not decrypt');
            return { provider: readOnlyForge(touched), repoFullName: 'w22-09/repo' };
          },
          draft: (deps: PatchDraftDeps) => runPatchDraft({ ...deps, runners: [runner], root }),
        },
      },
    };
    return aiPassProcessor(d);
  }

  async function queue(
    o: { egress?: EgressOf; fix?: FixConfig | null; config?: JudgeConfig } = {},
  ) {
    const r = await queueJudgeAfterScan(
      {
        db,
        config: o.config ?? CFG,
        egress: o.egress ?? egressOf(),
        ...(o.fix === null ? {} : { fixes: o.fix ?? FIX }),
        enqueue: async () => undefined,
      },
      { workspaceId: WS, repoId: REPO },
    );
    return r;
  }

  it('after judging, drafts verified fixes for the confirmed findings, riskiest first, and never writes to the forge', async () => {
    const top = await evalHit('src/top.js', { risk: '90.00' });
    const fp = await evalHit('src/fp.js', { risk: '80.00' });
    const low = await evalHit('src/low.js', { risk: '20.00' });
    const gw = scripted({
      verdictFor: (p) => (p.includes('src/fp.js') ? 'likely_false_positive' : 'real'),
    });
    const touched: string[] = [];
    const { runId } = await queue();
    const result = await processor(gw, { touched })(job(runId!));
    expect(result.status).toBe('succeeded');

    // Judged first (three triage calls), then two drafts, riskiest first.
    expect(gw.calls.map((c) => c.role)).toEqual(['triage', 'triage', 'triage', 'patch', 'patch']);
    const drafts = gw.calls.filter((c) => c.role === 'patch');
    expect(drafts[0]!.prompt).toContain('src/top.js');
    expect(drafts[1]!.prompt).toContain('src/low.js');
    expect(drafts.every((c) => c.initiator === 'ai-fix')).toBe(true);

    const run = await runOf(runId!);
    expect(run.calls).toBe(5);
    const plan = run.plan as { judge: JudgeSummary; fixes: FixSummary };
    expect(plan.judge).toMatchObject({ judged: 3, confirmed: 2 });
    expect(plan.fixes).toMatchObject({
      skipped: null,
      targets: 2,
      drafted: 2,
      verified: 2,
      rejected: 0,
      failed: 0,
      stopped: 'done',
    });

    for (const id of [top, low]) {
      const [p] = await patchesOf(id);
      expect(p).toMatchObject({ status: 'verified', commitSha: SHA, requestedBy: null, tier: 2 });
      expect(p!.diff).toContain('JSON.parse');
    }
    // A contradicted finding gets no fix.
    expect(await patchesOf(fp)).toHaveLength(0);
    // Read-only towards the forge (D9a).
    expect(touched).toContain('getFileContent');
    expect(touched.every((m) => ['kind', 'capabilities', 'getFileContent'].includes(m))).toBe(true);

    // Done: the next scan has nothing to judge and nothing to draft.
    expect(await queue()).toMatchObject({ queued: false, code: 'nothing_to_judge' });
  });

  it('a draft that fails the rescan is recorded with its reason, is not a fix, and is not drafted again', async () => {
    const bad = await evalHit('src/bad.js', { confirmed: true, risk: '90.00' });
    const good = await evalHit('src/good.js', { confirmed: true, risk: '50.00' });
    // Nothing to judge, but confirmed findings wait for a fix: a run is queued.
    const { runId, queued } = await queue();
    expect(queued).toBe(true);
    const gw = scripted({ goodFix: (p) => !p.includes('src/bad.js') });
    const result = await processor(gw)(job(runId!));
    expect(result.status).toBe('succeeded');

    const [rejected] = await patchesOf(bad);
    expect(rejected).toMatchObject({ status: 'rejected', requestedBy: null });
    expect(rejected!.reasonCode).toBeTruthy();
    expect(rejected!.reason).toBeTruthy();
    const [verified] = await patchesOf(good);
    expect(verified).toMatchObject({ status: 'verified' });

    const fixes = ((await runOf(runId!)).plan as { fixes: FixSummary }).fixes;
    expect(fixes).toMatchObject({ drafted: 2, verified: 1, rejected: 1 });
    expect(fixes.attempts.find((x) => x.finding_id === bad)).toMatchObject({ status: 'rejected' });

    // A rejection is a verdict: only a person's Try again asks the model again.
    expect(await queue()).toMatchObject({ queued: false, code: 'nothing_to_judge' });
    const { passedOver } = await pickFixTargets(db, WS, REPO, 5, new Date());
    expect(passedOver).toEqual(
      expect.arrayContaining([
        { finding_id: bad, code: 'answered_rejected' },
        { finding_id: good, code: 'answered_verified' },
      ]),
    );
  });

  it('a model timeout or forge failure on one draft is recorded on its row and the loop goes on', async () => {
    const times = await evalHit('src/times.js', { confirmed: true, risk: '90.00' });
    const ok = await evalHit('src/ok.js', { confirmed: true, risk: '50.00' });
    const { runId } = await queue();
    const gw = scripted({ patchThrows: (p) => p.includes('src/times.js') });
    expect((await processor(gw)(job(runId!))).status).toBe('succeeded');
    const [failed] = await patchesOf(times);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed!.reason).toMatch(/did not answer/);
    expect((await patchesOf(ok))[0]).toMatchObject({ status: 'verified' });
    expect(((await runOf(runId!)).plan as { fixes: FixSummary }).fixes).toMatchObject({
      failed: 1,
      verified: 1,
    });
    // A failed attempt waits a day before it is tried again.
    expect(await queue()).toMatchObject({ queued: false, code: 'nothing_to_judge' });

    // A forge that cannot be reached: recorded on the row, in its words.
    await db.delete(read.verifiedPatches).where(eq(read.verifiedPatches.workspaceId, WS));
    const next = await queue();
    await processor(scripted(), { forgeThrows: true })(job(next.runId!));
    expect((await patchesOf(ok))[0]).toMatchObject({ status: 'failed', reasonCode: 'error' });
    expect((await patchesOf(ok))[0]!.reason).toMatch(/will not decrypt/);
  });

  it('drafts at most `top` a run, only for findings whose rule can be re-run, within the time budget', async () => {
    for (let i = 0; i < 4; i++)
      await evalHit(`src/f${i}.js`, { confirmed: true, risk: String(90 - i) });
    // Not re-runnable: a model judgement has no rule to re-run on the patch.
    const llm = await evalHit('src/llm.js', {
      confirmed: true,
      risk: '99.00',
      scannerKey: 'logging',
      ruleId: 'llm-logging-judgement',
    });
    const { runId } = await queue({ fix: { enabled: true, top: 2 } });
    const gw = scripted();
    await processor(gw, { fix: { enabled: true, top: 2 } })(job(runId!));
    expect(gw.calls.filter((c) => c.role === 'patch')).toHaveLength(2);
    expect(await patchesOf(llm)).toHaveLength(0);
    // Every confirmed finding not attempted says why on the run.
    const picked = ((await runOf(runId!)).plan as { fixes: FixSummary }).fixes;
    expect(picked.passed_over).toEqual(
      expect.arrayContaining([
        { finding_id: llm, code: 'not_rerunnable' },
        expect.objectContaining({ code: 'over_top' }),
      ]),
    );
    expect(picked.passed_over).toHaveLength(3);

    // Time: each draft takes 40 s and the run may spend one minute.
    await clear();
    for (let i = 0; i < 3; i++)
      await evalHit(`src/t${i}.js`, { confirmed: true, risk: String(90 - i) });
    let clock = Date.now();
    const now = () => new Date(clock);
    const config = { ...CFG, scanMinutes: 1 };
    const timed = await queue({ config });
    const slow = scripted({ onCall: () => (clock += 40_000) });
    await processor(slow, { now, config })(job(timed.runId!));
    const fixes = ((await runOf(timed.runId!)).plan as { fixes: FixSummary }).fixes;
    expect(fixes).toMatchObject({ drafted: 2, stopped: 'time_budget', not_reached: 1 });
    // The drafting time is the judge run's wall clock: the same daily budget.
    expect((await runOf(timed.runId!)).budget).toBe('time');
  });

  it('keeps part of the run for drafting once a fix could be drafted', async () => {
    // One confirmed finding is already waiting for a fix; five hits to judge.
    await evalHit('src/waiting.js', { confirmed: true, risk: '95.00' });
    for (let i = 0; i < 5; i++) await evalHit(`src/j${i}.js`, { risk: String(80 - i) });
    let clock = Date.now();
    const now = () => new Date(clock);
    const config = { ...CFG, scanMinutes: 3 };
    const { runId } = await queue({ config });
    // Each call takes 40 s; the run has 180 s, of which 60 s are kept for fixes.
    const gw = scripted({ onCall: () => (clock += 40_000) });
    await processor(gw, { now, config })(job(runId!));
    const plan = (await runOf(runId!)).plan as { judge: JudgeSummary; fixes: FixSummary };
    expect(plan.judge).toMatchObject({ judged: 3, stopped: 'time_budget' });
    expect(plan.fixes.drafted).toBeGreaterThanOrEqual(1);
  });

  it('AI off stops fix drafts, and a hosted fix route is not used without the opt-in', async () => {
    const id = await evalHit('src/a.js', { confirmed: true });
    await db.insert(read.aiPassSettings).values({ workspaceId: WS, aiPaused: true });
    expect(await queue()).toMatchObject({ queued: false, code: 'ai_paused' });
    await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, WS));

    // Triage is local, the patch role is hosted: nothing to judge, no draft.
    const hostedPatch = egressOf({ patchLeaves: true });
    expect(await queue({ egress: hostedPatch })).toMatchObject({
      queued: false,
      code: 'nothing_to_judge',
    });
    // A run that is queued anyway (a hit to judge) judges, and drafts nothing.
    await evalHit('src/b.js');
    const { runId } = await queue({ egress: hostedPatch });
    const gw = scripted({ verdictFor: () => 'likely_false_positive' });
    await processor(gw, { egress: hostedPatch })(job(runId!));
    expect(gw.calls.some((c) => c.role === 'patch')).toBe(false);
    expect(((await runOf(runId!)).plan as { fixes: FixSummary }).fixes).toMatchObject({
      skipped: 'patch_route_hosted',
    });
    expect(await patchesOf(id)).toHaveLength(0);
  });

  it('stays in its workspace (Law 5): another workspace’s confirmed findings get no draft', async () => {
    const mine = await evalHit('src/mine.js', { confirmed: true });
    const theirs = await evalHit('src/theirs.js', { confirmed: true, ws: OTHER, repo: OTHER_REPO });
    const { runId } = await queue();
    const gw = scripted();
    await processor(gw)(job(runId!));
    expect((await patchesOf(mine))[0]).toMatchObject({ status: 'verified', workspaceId: WS });
    expect(await patchesOf(theirs)).toHaveLength(0);
    expect(gw.calls.filter((c) => c.role === 'patch')).toHaveLength(1);
  });
});
