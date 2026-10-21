// W19-14: run the AI pass FOR REAL, end to end, on a dev machine - and say what ran.
//
//   AI-pass diff mode (a pull request) and a scheduled pass, through the SHIPPING
//   worker (not a test double), a real model, and a forge that is a loopback fake.
//
//   LIVE_MODEL=qwen/qwen3.8-27b LIVE_OUT=/tmp/ai-pass-live.json \
//     pnpm --filter @repopulse/api exec tsx src/dev/ai-pass-live-check.ts
//
// WHAT RUNS FOR REAL
//   - The worker process (apps/api/src/workers/index.ts) with its real ai.pass
//     processor, its real scheduler tick (AI_PASS_SCHEDULER_TICK_MS), real Redis
//     queues and a real Postgres.
//   - The GitHub forge adapter and the budgeted client, talking over HTTP to the
//     fake forge (packages/shared/src/testing/fake/forge.ts) on 127.0.0.1, reached
//     through FORGE_BASE_URL + FORGE_ALLOW_INSECURE_LOOPBACK (the worker's loopback
//     override, which is refused for any non-loopback host).
//   - The model: LM Studio (or any OpenAI-compatible server) you point it at.
//
// WHAT DOES NOT
//   - The forge is a fake, serving two made-up pull requests. No real repository.
//   - The pass is queued by inserting the run row and a job, not through the
//     POST route (that route needs a login session); the schedule is a row with
//     the acknowledgement digest the PUT route would have stored.
//
// SAFETY: the model server must be on this machine's network. The script refuses
// a base URL that is not loopback or a private IP, so nothing is sent to a hosted
// model. Every row it creates is removed afterwards and the schedule is disabled.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { credentials } from '@repopulse/auth';
import { QUEUE, createQueue, createRedisConnection } from '@repopulse/ingest';
import {
  FAKE_PR_FILES,
  FAKE_TOKEN,
  core,
  createDb,
  facts,
  read,
  security,
  startFakeForge,
} from '@repopulse/shared';
import { passEgress } from '../lib/ai-pass-egress.js';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const MODEL = process.env.LIVE_MODEL ?? 'qwen/qwen3.8-27b';
const MODEL_URL = process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1';
const OUT = process.env.LIVE_OUT ?? 'ai-pass-live.json';
const MAX_CALLS = Number(process.env.LIVE_MAX_CALLS ?? 6);
const TICK_MS = Number(process.env.LIVE_TICK_MS ?? 15_000);
const HEALTH_PORT = Number(process.env.LIVE_WORKER_PORT ?? 3397);
const RUN_TIMEOUT_MS = Number(process.env.LIVE_RUN_TIMEOUT_MS ?? 40 * 60_000);
if (!DATABASE_URL || !REDIS_URL) throw new Error('DATABASE_URL and REDIS_URL are required');

// ---- refuse anything that could leave the network --------------------------------
function assertOnNetwork(url: string): void {
  const host = new URL(url).hostname;
  const ok =
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!ok) throw new Error(`refusing to send source to ${host}: not loopback or a private IP`);
}
assertOnNetwork(MODEL_URL);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[live ${new Date().toISOString().slice(11, 19)}] ${m}`);

const db = createDb(DATABASE_URL);
const TOKEN_KEY = process.env.TOKEN_ENC_KEY ?? randomBytes(32).toString('hex');
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  model: MODEL,
  modelUrl: MODEL_URL,
  maxCallsPerPass: MAX_CALLS,
  tickMs: TICK_MS,
  ranForReal: [
    'the shipping worker process, its ai.pass processor and its scheduler tick',
    'real Redis queues and Postgres',
    'the GitHub adapter and budgeted client over HTTP to a loopback fake forge',
    `the model ${MODEL} at ${MODEL_URL}`,
  ],
  notReal: [
    'the forge is a fake serving two made-up pull requests',
    'the manual pass was queued by a row and a job, not the POST route (needs a login session)',
    'the schedule row carries the digest the PUT route would store; the PUT route was not exercised live',
  ],
};

let worker: ChildProcess | null = null;
let ws = 0;

async function waitFor<T>(what: string, fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5000);
  }
}

async function cleanup(workspaceId: number): Promise<void> {
  if (!workspaceId) return;
  await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, workspaceId));
  await db
    .delete(read.aiFindingProvenance)
    .where(eq(read.aiFindingProvenance.workspaceId, workspaceId));
  await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, workspaceId));
  await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, workspaceId));
  await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, workspaceId));
  await db.delete(read.findings).where(eq(read.findings.workspaceId, workspaceId));
  await db.delete(read.analysisRuns).where(eq(read.analysisRuns.workspaceId, workspaceId));
  await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, workspaceId));
  await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
  await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, workspaceId));
  await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, workspaceId));
  await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
  await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
  await db.delete(core.forgeConnections).where(eq(core.forgeConnections.workspaceId, workspaceId));
}

async function main(): Promise<void> {
  // ---- the model is reachable and has the model ----------------------------------
  const models = (await (await fetch(`${MODEL_URL}/models`)).json()) as { data?: { id: string }[] };
  if (!models.data?.some((m) => m.id === MODEL))
    throw new Error(`${MODEL} is not loaded at ${MODEL_URL}`);

  // ---- fixtures: an own workspace, a repo behind the fake forge, rule findings ----
  const slug = 'w19-14-live';
  await db.insert(core.workspaces).values({ slug, name: 'W19-14 live' }).onConflictDoNothing();
  ws = (
    await db.select({ id: core.workspaces.id }).from(core.workspaces).where(eq(core.workspaces.slug, slug)).limit(1)
  )[0]!.id;
  await cleanup(ws);
  await db
    .insert(core.users)
    .values({ authProvider: 'local', authSubject: 'w19-14@example.test', login: 'live-admin', email: 'w19-14@example.test' })
    .onConflictDoNothing();
  const userId = (
    await db.select({ id: core.users.id }).from(core.users).where(eq(core.users.authSubject, 'w19-14@example.test')).limit(1)
  )[0]!.id;

  const forge = await startFakeForge(0);
  log(`fake forge on ${forge.baseUrl}`);
  const enc = credentials.encryptCredential(FAKE_TOKEN, Buffer.from(TOKEN_KEY, 'hex'));
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
  const [repo] = await db
    .insert(core.repos)
    .values({
      workspaceId: ws,
      connectionId: conn!.id,
      forgeRepoId: 'live-alpha',
      org: 'fixture-org',
      name: 'alpha-service',
      defaultBranch: 'main',
      isPrivate: true,
      isArchived: false,
      syncStatus: 'live',
      tier2Auto: false,
    })
    .returning({ id: core.repos.id });
  const REPO = repo!.id;
  const [ident] = await db
    .insert(core.identities)
    .values({ workspaceId: ws, provider: 'github', forgeLogin: 'live-dev', displayName: 'Live dev' })
    .returning({ id: core.identities.id });
  const addPr = async (number: number, title: string, updatedAt: Date) => {
    await db.insert(facts.pullRequests).values({
      workspaceId: ws,
      repoId: REPO,
      number,
      forgePrId: `live-pr-${number}`,
      title,
      authorIdentityId: ident!.id,
      state: 'open',
      isDraft: false,
      isBot: false,
      createdAt: updatedAt,
      updatedAt,
      baseRef: 'main',
      headSha: `live${number}`.padEnd(40, '0'),
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
  };
  await addPr(12, 'Add refund lookup for the support console', new Date(Date.now() - 3_600_000));

  // A model on THIS network, and nothing else configured.
  await db.insert(core.llmProviders).values({
    workspaceId: ws,
    name: 'LM Studio (live check)',
    kind: 'openai_compatible',
    baseUrl: MODEL_URL,
    model: MODEL,
    allowPublicHost: false,
  });

  // Rule findings, as the scanners would have stored them (with our code context).
  const [scan] = await db
    .insert(security.scanRuns)
    .values({
      workspaceId: ws,
      repoId: REPO,
      scannerKey: 'semgrep',
      scannerVersion: 'live',
      commitSha: 'live12'.padEnd(40, '0'),
      trigger: 'manual',
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .returning({ id: security.scanRuns.id });
  const refundSource = FAKE_PR_FILES[12]![0]!.patch
    .split('\n')
    .slice(1)
    .map((l) => l.slice(1))
    .join('\n');
  const sessionSource = [
    "import { signToken } from './token';",
    '',
    '// Issue a session cookie after a successful login.',
    'export function issueSession(res, userId) {',
    '  // the account must exist and be active',
    '  if (!userId) throw new Error("no user");',
    '  audit("session.issue", { userId });',
    '  rotateSessionKey();',
    '  recordLoginTime(userId);',
    '  const meta = { ua: res.req.headers["user-agent"] };',
    '  void meta;',
    '  // (twelve lines of unrelated setup elided in the real file)',
    '  void 1;',
    '  void 2;',
    '  void 3;',
    '  void 4;',
    '  void 5;',
    '  void 6;',
    '  void 7;',
    '  void 8;',
    '  const token = signToken({ sub: userId });',
    "  res.cookie('sid', token, { httpOnly: false, secure: false });",
    '  return token;',
    '}',
  ].join('\n');
  const rule = (
    file: string,
    line: number,
    title: string,
    ruleId: string,
    source: string,
    evidenceLine: string,
  ) => ({
    workspaceId: ws,
    repoId: REPO,
    scanRunId: scan!.id,
    dimension: 'sast',
    severity: 4,
    confidence: 4,
    title,
    scannerKey: 'semgrep',
    ruleId,
    file,
    lineStart: line,
    lineEnd: line,
    evidence: evidenceLine,
    recommendation: 'review',
    tier: 1,
    dedupKey: `live-${ruleId}-${file}-${line}`,
    status: 'open',
    effectiveRisk: '80.00',
    contextLines: source,
    contextStartLine: 1,
  });
  const ruleRows = await db
    .insert(read.findings)
    .values([
      rule('src/payments/refund.ts', 7, 'SQL built by string concatenation', 'bpm-sql-built-variable', refundSource, refundSource.split('\n')[6]!),
      // An over-eager rule flagging the PARAMETERISED query: triage should say it is not real.
      rule('src/payments/refund.ts', 14, 'Query built from a variable', 'bpm-sql-built-variable-weak', refundSource, refundSource.split('\n')[13]!),
      // Real, but NOT on a line the pull request changes: must not be triaged in diff mode.
      rule('src/legacy/old.ts', 3, 'Use of eval', 'bpm-eval', "// legacy\n// legacy\nconst r = eval(userInput);\n", 'const r = eval(userInput);'),
    ])
    .returning({ id: read.findings.id, file: read.findings.file, line: read.findings.lineStart });
  evidence.fixtures = { workspace: ws, repo: REPO, ruleFindings: ruleRows };

  // ---- the shipping worker, pointed at the fake forge, ticking fast ----------------
  mkdirSync(dirname(OUT), { recursive: true });
  const workerLog = createWriteStream(`${OUT}.worker.log`);
  worker = spawn('pnpm', ['--filter', '@repopulse/api', 'exec', 'tsx', 'src/workers/index.ts'], {
    detached: true,
    env: {
      ...process.env,
      DATABASE_URL,
      REDIS_URL,
      TOKEN_ENC_KEY: TOKEN_KEY,
      FORGE_BASE_URL: forge.baseUrl,
      FORGE_ALLOW_INSECURE_LOOPBACK: '1',
      WORKER_HEALTH_PORT: String(HEALTH_PORT),
      AI_PASS_SCHEDULER_TICK_MS: String(TICK_MS),
      RECONCILE_CRON: 'off',
      SECRETS_HISTORY_CRON: 'off',
      SECURITY_WEEKLY_CRON: 'off',
      REGISTERS_NIGHTLY_CRON: 'off',
      SECURITY_CHAIN_CRON: 'off',
    },
  });
  worker.stdout?.pipe(workerLog);
  worker.stderr?.pipe(workerLog);
  await waitFor('the worker to come up', async () => {
    try {
      return (await fetch(`http://127.0.0.1:${HEALTH_PORT}/healthz`)).ok ? true : null;
    } catch {
      return null;
    }
  }, 120_000);
  log('worker up');

  const connection = createRedisConnection(REDIS_URL!);
  const queue = createQueue(QUEUE.aiPass, connection);

  const finished = async (where: ReturnType<typeof sql>) =>
    waitFor('a finished pass', async () => {
      const [r] = await db
        .select()
        .from(read.aiPassRuns)
        .where(and(eq(read.aiPassRuns.workspaceId, ws), where))
        .limit(1);
      return r && ['succeeded', 'failed', 'skipped'].includes(r.status) ? r : null;
    }, RUN_TIMEOUT_MS);

  const describeRun = async (runId: number) => {
    const [run] = await db.select().from(read.aiPassRuns).where(eq(read.aiPassRuns.id, runId));
    const verdicts = await db
      .select({ v: read.aiTriageVerdicts, file: read.findings.file, line: read.findings.lineStart, ctx: read.findings.contextLines, startLine: read.findings.contextStartLine, status: read.findings.status })
      .from(read.aiTriageVerdicts)
      .innerJoin(read.findings, eq(read.findings.id, read.aiTriageVerdicts.findingId))
      .where(and(eq(read.aiTriageVerdicts.workspaceId, ws), eq(read.aiTriageVerdicts.aiPassRunId, runId)));
    const raised = await db
      .select({ p: read.aiFindingProvenance, title: read.findings.title, file: read.findings.file, line: read.findings.lineStart, status: read.findings.status, evidence: read.findings.evidence })
      .from(read.aiFindingProvenance)
      .innerJoin(read.findings, eq(read.findings.id, read.aiFindingProvenance.findingId))
      .where(and(eq(read.aiFindingProvenance.workspaceId, ws), eq(read.aiFindingProvenance.aiPassRunId, runId)));
    return {
      run: {
        id: run!.id,
        mode: run!.mode,
        trigger: run!.trigger,
        status: run!.status,
        reasonCode: run!.reasonCode,
        reason: run!.reason,
        calls: run!.calls,
        prNumber: run!.prNumber,
        baseRef: run!.baseRef,
        headRef: run!.headRef,
        commitSha: run!.commitSha,
        specialists: run!.specialists,
        triageFunnel: run!.triageFunnel,
        triageSkipped: run!.triageSkipped,
        startedAt: run!.startedAt,
        finishedAt: run!.finishedAt,
      },
      specialistFindings: raised.map((r) => ({
        specialist: r.p.specialist,
        model: r.p.model,
        route: r.p.route,
        title: r.title,
        file: r.file,
        line: r.line,
        status: r.status,
        evidence: r.evidence,
      })),
      suggestions: verdicts.map(({ v, file, line, ctx, startLine, status }) => ({
        finding: `${file}:${line}`,
        verdict: v.verdict,
        confidence: v.confidence,
        rationale: v.rationale,
        model: v.model,
        route: v.route,
        citations: (v.citations as { file: string; line: number; text: string }[]).map((c) => ({
          ...c,
          // Evidence-fed: the cited text must be OUR copy of that line.
          matchesOurCopy:
            (ctx ?? '').split('\n')[c.line - (startLine ?? 1)]?.trim() === c.text.trim(),
        })),
        vex: v.vexJustification,
        decision: v.decision,
        findingStatusAfter: status,
      })),
    };
  };

  // ============ PART 1: diff mode, a pull request, through the worker ===============
  log(`part 1: pull request #12, up to ${MAX_CALLS} calls`);
  const [run1] = await db
    .insert(read.aiPassRuns)
    .values({ workspaceId: ws, repoId: REPO, requestedBy: userId, paths: [], mode: 'pull_request', prNumber: 12 })
    .returning({ id: read.aiPassRuns.id });
  const t1 = Date.now();
  await queue.add('ai.pass', { workspaceId: ws, runId: run1!.id, maxCalls: MAX_CALLS }, { jobId: `ai-pass-${run1!.id}` });
  await finished(sql`${read.aiPassRuns.id} = ${run1!.id}`);
  evidence.part1 = { seconds: Math.round((Date.now() - t1) / 1000), ...(await describeRun(run1!.id)) };
  log(`part 1 done in ${(evidence.part1 as { seconds: number }).seconds}s`);

  // ============ PART 2: a scheduled pass, found by the worker's own tick ============
  const used = (await db.select({ n: sql<number>`coalesce(sum(calls),0)::int` }).from(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, ws)))[0]!.n;
  // The monthly cap leaves exactly MAX_CALLS for this scheduled pass.
  await db.insert(read.aiPassSettings).values({ workspaceId: ws, monthlyCallCap: used + MAX_CALLS, updatedBy: userId }).onConflictDoUpdate({ target: read.aiPassSettings.workspaceId, set: { monthlyCallCap: used + MAX_CALLS } });
  const egress = await passEgress(db, ws);
  evidence.egress = { sentence: egress.sentence, leavesNetwork: egress.leaves_network, destinations: egress.destinations };
  if (egress.leaves_network) throw new Error('something would leave the network; refusing to schedule');
  const enabledAt = new Date();
  const [sch] = await db
    .insert(read.aiPassSchedules)
    .values({
      workspaceId: ws,
      repoId: REPO,
      enabled: true,
      frequency: 'daily',
      scopeKind: 'new_pull_requests',
      paths: [],
      egressDigest: egress.digest,
      egressAck: { destinations: egress.destinations, acknowledged_at: enabledAt.toISOString() } as Record<string, unknown>,
      enabledBy: userId,
      enabledAt,
      nextRunAt: new Date(enabledAt.getTime() + 5_000),
    })
    .returning({ id: read.aiPassSchedules.id });
  // A pull request that is NEW since the schedule was enabled.
  await addPr(13, 'Loosen the session cookie for the embedded widget', new Date(Date.now() + 2_000));
  await db.insert(read.findings).values(rule('src/auth/session.ts', 21, 'Cookie without Secure/HttpOnly', 'bpm-insecure-cookie', sessionSource, sessionSource.split('\n')[20]!));
  log('part 2: schedule enabled; waiting for the worker tick');
  const t2 = Date.now();
  const scheduled = await finished(sql`${read.aiPassRuns.trigger} = 'scheduled'`);
  evidence.part2 = {
    secondsFromEnableToFinish: Math.round((Date.now() - t2) / 1000),
    tickMs: TICK_MS,
    ...(await describeRun(scheduled.id)),
  };

  // ---- disable, and show the next tick starts nothing ------------------------------
  await db.update(read.aiPassSchedules).set({ enabled: false, nextRunAt: null }).where(eq(read.aiPassSchedules.id, sch!.id));
  const before = (await db.select({ n: sql<number>`count(*)::int` }).from(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, ws)))[0]!.n;
  await sleep(TICK_MS * 2 + 5000);
  const after = (await db.select({ n: sql<number>`count(*)::int` }).from(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, ws)))[0]!.n;
  evidence.disabled = { runsBefore: before, runsAfterTwoTicks: after, startedNothing: before === after };

  // The rule findings are still open: nothing was dismissed or changed.
  const stillOpen = await db.select({ file: read.findings.file, line: read.findings.lineStart, status: read.findings.status }).from(read.findings).where(and(eq(read.findings.workspaceId, ws), inArray(read.findings.id, ruleRows.map((r) => r.id))));
  evidence.ruleFindingsAfter = stillOpen;
  const auditLines = (await import('node:fs')).readFileSync(`${OUT}.worker.log`, 'utf8').split('\n').filter((l) => /egress|audit:ai_pass/.test(l)).length;
  evidence.workerLogLines = { egressOrAiPassAudit: auditLines };

  await queue.close();
  await connection.quit();
  await forge.close();
}

main()
  .then(() => {
    evidence.finishedAt = new Date().toISOString();
    evidence.ok = true;
  })
  .catch((err: unknown) => {
    evidence.ok = false;
    evidence.error = err instanceof Error ? err.message : String(err);
    console.error(err);
  })
  .finally(async () => {
    if (worker?.pid) {
      try {
        process.kill(-worker.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    try {
      await cleanup(ws);
      evidence.cleanedUp = true;
    } catch (err) {
      evidence.cleanedUp = false;
      evidence.cleanupError = String(err);
    }
    writeFileSync(OUT, JSON.stringify(evidence, null, 2));
    log(`evidence written to ${OUT}`);
    await db.$client.end();
    process.exit(evidence.ok ? 0 : 1);
  });
