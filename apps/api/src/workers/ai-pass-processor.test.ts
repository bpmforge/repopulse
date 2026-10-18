import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import type { Job } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import {
  createAnalysisGateway,
  type AnalysisGateway,
  type CompleteOpts,
  type CompleteResult,
  type RoutingPolicy,
  type T2Host,
} from '@repopulse/analysis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiPassProcessor,
  inScope,
  type AiPassDeps,
  type AiPassJobData,
  type PassFile,
} from './ai-pass-processor.js';

// W19-09. The AI pass, end to end against the real tables with a scripted model:
// what it stores, and - as important - what it can never do. A pass writes
// findings and SUGGESTIONS; it does not touch an existing finding's status.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const FILES: PassFile[] = [
  {
    path: 'src/routes/users.ts',
    content: [
      'export function register(app) {',
      "  app.get('/u/:id', async (req, res) => {",
      '    const rows = await db.query("SELECT * FROM users WHERE id = " + req.params.id);',
      '    res.json(rows);',
      '  });',
      '}',
    ].join('\n'),
  },
];

/** A scripted model: specialists quote a real line from the prompt; triage cites the flagged line. */
function scripted(opts: { triageVerdict?: string; onCall?: (role: string) => void } = {}) {
  const calls: { role: string | undefined; prompt: string }[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt: string, o: CompleteOpts): Promise<CompleteResult> {
      const role = o.meta.role;
      calls.push({ role, prompt });
      opts.onCall?.(role ?? '');
      let text: string;
      if (role === 'triage') {
        const flagged = /Flagged lines: (\d+)-/.exec(prompt)?.[1] ?? '1';
        const line = new RegExp(`^\\s*${flagged}\\| (.*)$`, 'm').exec(prompt)?.[1] ?? '';
        text = JSON.stringify({
          verdict: opts.triageVerdict ?? 'real',
          confidence: 4,
          citations: [{ line: Number(flagged), quote: line.trim().slice(0, 30) }],
          rationale: 'the cited line decides it',
          vex_justification:
            opts.triageVerdict === 'likely_false_positive'
              ? 'inline_mitigations_already_exist'
              : null,
          vex_statement:
            opts.triageVerdict === 'likely_false_positive' ? 'validated upstream' : null,
          patch: null,
        });
      } else {
        const quote = /^\+(.*db\.query\(.*)$/m.exec(prompt)?.[1]?.trim();
        text = JSON.stringify({
          findings: quote
            ? [
                {
                  dimension: role,
                  severity: 4,
                  confidence: 4,
                  file: 'src/routes/users.ts',
                  line_range: [3, 3],
                  title: `${role}: SQL built from a parameter`,
                  evidence_quote: quote,
                  rationale: 'concatenated',
                  suggested_fix: null,
                },
              ]
            : [],
        });
      }
      return {
        text,
        model: 'scripted-model',
        tokensIn: 100,
        tokensOut: 20,
        costUsd: null,
        durationMs: 1,
        route: {
          role: (role ?? null) as never,
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
  return { gateway, calls };
}

describeIfLiveInfra('the AI pass processor (W19-09)', () => {
  const db = createDb(databaseUrl as string);
  let WS = 0;
  let OTHER = 0;
  let REPO = 0;
  let scanRunId = 0;
  let connectionId = 0;

  async function clear() {
    for (const w of [WS, OTHER]) {
      if (!w) continue;
      await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, w));
      await db.delete(read.aiFindingProvenance).where(eq(read.aiFindingProvenance.workspaceId, w));
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, w));
    }
    await db
      .delete(read.findings)
      .where(and(eq(read.findings.workspaceId, WS), eq(read.findings.repoId, REPO)));
    await db
      .delete(read.analysisRuns)
      .where(and(eq(read.analysisRuns.workspaceId, WS), eq(read.analysisRuns.repoId, REPO)));
  }

  beforeAll(async () => {
    // Own fixtures: the seeded warehouse is wiped by other suites, so a test
    // that borrows its repository fails for reasons that have nothing to do with it.
    await db
      .insert(core.workspaces)
      .values({ slug: 'w19-09-ws', name: 'W19-09' })
      .onConflictDoNothing();
    WS = (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, 'w19-09-ws'))
        .limit(1)
    )[0]!.id;
    await db
      .insert(core.workspaces)
      .values({ slug: 'w19-09-other', name: 'Other' })
      .onConflictDoNothing();
    OTHER = (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, 'w19-09-other'))
        .limit(1)
    )[0]!.id;
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w19-09@example.test',
        login: 'w19-09',
        email: 'w19-09@example.test',
      })
      .onConflictDoNothing();
    const userId = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w19-09@example.test'))
        .limit(1)
    )[0]!.id;
    const enc = credentials.encryptCredential('w19-09-fixture-token', Buffer.alloc(32, 7));
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
        createdBy: userId,
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = conn!.id;
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: WS,
        connectionId,
        forgeRepoId: 'w19-09-repo',
        org: 'w19-09',
        name: 'repo',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .onConflictDoNothing()
      .returning({ id: core.repos.id });
    REPO =
      repo?.id ??
      (
        await db
          .select({ id: core.repos.id })
          .from(core.repos)
          .where(and(eq(core.repos.workspaceId, WS), eq(core.repos.forgeRepoId, 'w19-09-repo')))
          .limit(1)
      )[0]!.id;
    await clear();
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
  });
  afterAll(async () => {
    await clear();
    await db.delete(security.scanRuns).where(eq(security.scanRuns.id, scanRunId));
    await db.delete(core.repos).where(eq(core.repos.id, REPO));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, OTHER));
    await db.$client.end();
  });
  beforeEach(clear);

  /** A rule-raised, open finding with the stored code context the scan keeps. */
  async function ruleFinding(over: Partial<typeof read.findings.$inferInsert> = {}) {
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
        ruleId: 'bpm-sql-built-variable',
        file: 'src/routes/users.ts',
        lineStart: 3,
        lineEnd: 3,
        evidence: 'db.query("SELECT * FROM users WHERE id = " + req.params.id)',
        recommendation: 'parameterise',
        tier: 2,
        dedupKey: `w19-09-${Math.random().toString(36).slice(2)}`,
        status: 'open',
        effectiveRisk: '80.00',
        contextLines: FILES[0]!.content,
        contextStartLine: 1,
        ...over,
      })
      .returning({ id: read.findings.id });
    return f!.id;
  }

  async function newRun(paths = ['src'], workspaceId = WS) {
    const [r] = await db
      .insert(read.aiPassRuns)
      .values({ workspaceId, repoId: REPO, paths })
      .returning({ id: read.aiPassRuns.id });
    return r!.id;
  }
  const job = (runId: number, workspaceId = WS) =>
    ({ data: { workspaceId, runId } }) as Job<AiPassJobData>;
  const runOf = async (id: number) =>
    (await db.select().from(read.aiPassRuns).where(eq(read.aiPassRuns.id, id)))[0]!;

  function deps(
    over: Partial<AiPassDeps> = {},
    gw = scripted(),
  ): { d: AiPassDeps; gw: ReturnType<typeof scripted> } {
    return {
      gw,
      d: {
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
        loadSources: async () => ({ ok: true, commitSha: 'abcdef1234567890', files: FILES }),
        ...over,
      },
    };
  }

  it('runs the planned specialists, stores their findings with provenance, and stores a triage SUGGESTION - changing nothing else', async () => {
    const existing = await ruleFinding();
    const before = await db
      .select({
        id: read.findings.id,
        status: read.findings.status,
        dismissReason: read.findings.dismissReason,
      })
      .from(read.findings)
      .where(eq(read.findings.id, existing));
    const runId = await newRun();
    const { d, gw } = deps();
    const result = await aiPassProcessor(d)(job(runId));
    expect(result.status).toBe('succeeded');

    const run = await runOf(runId);
    expect(run).toMatchObject({ status: 'succeeded', commitSha: 'abcdef1234567890' });
    expect(run.calls).toBe(gw.calls.length);
    expect((run.plan as { waves: unknown[] }).waves.length).toBeGreaterThan(0);

    // Specialist findings: ordinary findings, with their dimension, no scanner/rule, leading '+' stripped.
    const mine = await db
      .select()
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, WS),
          inArray(read.findings.dimension, [
            'security',
            'best_practices',
            'ai_slop',
            'code_health',
            'test_coverage',
            'performance',
          ]),
          eq(read.findings.title, 'security: SQL built from a parameter'),
        ),
      );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      dimension: 'security',
      scannerKey: null,
      ruleId: null,
      status: 'open',
      tier: 2,
    });
    expect(mine[0]!.evidence).not.toMatch(/^\+/);

    // How it was raised: the model and the routing link.
    const [prov] = await db
      .select()
      .from(read.aiFindingProvenance)
      .where(eq(read.aiFindingProvenance.findingId, mine[0]!.id));
    expect(prov).toMatchObject({
      specialist: 'security',
      model: 'scripted-model',
      aiPassRunId: runId,
    });
    expect(prov!.route).toMatchObject({ providerName: 'LM Studio', linkIndex: 0 });
    expect((run.analysisRunIds as number[]).length).toBeGreaterThan(0);

    // Triage: a suggestion for the RULE-raised finding, citing OUR copy of the stored line.
    const [v] = await db
      .select()
      .from(read.aiTriageVerdicts)
      .where(eq(read.aiTriageVerdicts.findingId, existing));
    expect(v).toMatchObject({
      verdict: 'real',
      model: 'scripted-model',
      decision: null,
      decidedBy: null,
      patchStatus: 'not_attempted',
      patchDiff: null,
    });
    expect(v!.citations[0]).toMatchObject({ file: 'src/routes/users.ts', line: 3 });
    expect(v!.citations[0]!.text).toContain('db.query');
    expect((run.triageFunnel as { dismissed: number }).dismissed).toBe(0);

    // THE POINT: the rule-raised finding is exactly as it was.
    const after = await db
      .select({
        id: read.findings.id,
        status: read.findings.status,
        dismissReason: read.findings.dismissReason,
      })
      .from(read.findings)
      .where(eq(read.findings.id, existing));
    expect(after).toEqual(before);
  });

  it('a likely-false-positive verdict carries a VEX PROPOSAL and still does not dismiss anything', async () => {
    const existing = await ruleFinding();
    const runId = await newRun();
    await aiPassProcessor(deps({}, scripted({ triageVerdict: 'likely_false_positive' })).d)(
      job(runId),
    );
    const [v] = await db
      .select()
      .from(read.aiTriageVerdicts)
      .where(eq(read.aiTriageVerdicts.findingId, existing));
    expect(v).toMatchObject({
      verdict: 'likely_false_positive',
      vexJustification: 'inline_mitigations_already_exist',
      vexStatement: 'validated upstream',
    });
    const [f] = await db
      .select({ status: read.findings.status })
      .from(read.findings)
      .where(eq(read.findings.id, existing));
    expect(f!.status).toBe('open');
  });

  it("skips triage for a finding that already has a suggestion, so a person's decision is never re-asked", async () => {
    const existing = await ruleFinding();
    const first = await newRun();
    await aiPassProcessor(deps().d)(job(first));
    await db
      .update(read.aiTriageVerdicts)
      .set({ decision: 'dismissed', decidedAt: new Date() })
      .where(eq(read.aiTriageVerdicts.findingId, existing));
    const second = await newRun();
    const { d, gw } = deps();
    await aiPassProcessor(d)(job(second));
    expect(gw.calls.filter((c) => c.role === 'triage')).toHaveLength(0);
    expect((await runOf(second)).triageSkipped).toMatch(/nothing to triage/);
    expect(
      await db
        .select()
        .from(read.aiTriageVerdicts)
        .where(eq(read.aiTriageVerdicts.findingId, existing)),
    ).toHaveLength(1);
  });

  it('only triages findings in scope, and only those with stored context', async () => {
    const inside = await ruleFinding({ file: 'src/routes/users.ts' });
    const outside = await ruleFinding({ file: 'lib/other.ts' });
    const noContext = await ruleFinding({ contextLines: null, contextStartLine: null });
    const runId = await newRun(['src/routes']);
    await aiPassProcessor(deps().d)(job(runId));
    const triaged = (
      await db
        .select({ id: read.aiTriageVerdicts.findingId })
        .from(read.aiTriageVerdicts)
        .where(eq(read.aiTriageVerdicts.workspaceId, WS))
    ).map((r) => r.id);
    expect(triaged).toEqual([inside]);
    expect(triaged).not.toContain(outside);
    expect(triaged).not.toContain(noContext);
  });

  it('fails by name when the workspace has no model', async () => {
    const runId = await newRun();
    const r = await aiPassProcessor(deps({ gatewayFor: async () => null }).d)(job(runId));
    expect(r).toMatchObject({ status: 'failed', code: 'no_gateway' });
    expect((await runOf(runId)).reason).toMatch(/Add one in Admin → Models/);
  });

  it('records a named reason when the sources cannot be loaded', async () => {
    const runId = await newRun();
    await aiPassProcessor(
      deps({
        loadSources: async () => ({
          ok: false,
          code: 'too_large',
          reason: '90 files; the limit is 40.',
        }),
      }).d,
    )(job(runId));
    expect(await runOf(runId)).toMatchObject({
      status: 'failed',
      reasonCode: 'too_large',
      reason: '90 files; the limit is 40.',
    });
  });

  it('honours local-only: a routed role that would leave the network fails the pass with the sentence, and sends nothing', async () => {
    const cloud: T2Host = {
      baseUrl: 'https://api.example-llm.com/v1',
      modelSlot: 'c',
      providerId: 9,
      name: 'Hosted',
    };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const routing: RoutingPolicy = {
      localOnly: true,
      chains: { security: [{ host: cloud, providerName: 'Hosted' }] },
    };
    const gateway = createAnalysisGateway({ hosts: [cloud], routing, fetchImpl });
    const runId = await newRun();
    const r = await aiPassProcessor(
      deps({ gatewayFor: async () => ({ gateway, hosts: [cloud], routing }) }).d,
    )(job(runId));
    expect(r.status).toBe('failed');
    expect((await runOf(runId)).reason).toMatch(
      /Local-only is on: role "security" would send to connection "Hosted", which is outside your network/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reserves part of the cap for triage, so a tight cap cannot starve it - and the total never exceeds the cap', async () => {
    await ruleFinding();
    const runId = await newRun();
    const { d, gw } = deps({ maxCalls: 6 });
    await aiPassProcessor(d)(job(runId));
    const run = await runOf(runId);
    expect(gw.calls.length).toBeLessThanOrEqual(6);
    expect(gw.calls.filter((c) => c.role === 'triage')).toHaveLength(1); // triage ran
    expect((run.specialists as { usage: Record<string, { calls: number }> }).usage).toBeTruthy();
    expect(
      (run.specialists as { droppedForBudget: string[] }).droppedForBudget.length,
    ).toBeGreaterThan(0);
  });

  it('honours the call cap: later specialists are dropped and said so, and triage is skipped when the cap is used up', async () => {
    await ruleFinding();
    const runId = await newRun();
    const { d, gw } = deps({ maxCalls: 2 });
    await aiPassProcessor(d)(job(runId));
    const run = await runOf(runId);
    expect(gw.calls.length).toBeLessThanOrEqual(2);
    expect(
      (run.specialists as { droppedForBudget: string[] }).droppedForBudget.length,
    ).toBeGreaterThan(0);
    expect(run.triageSkipped).toMatch(/call cap was used up/);
  });

  it('a docs-only scope is "skipped: nothing relevant", not a clean success', async () => {
    const runId = await newRun(['docs']);
    const r = await aiPassProcessor(
      deps({
        loadSources: async () => ({
          ok: true,
          commitSha: 'a1',
          files: [{ path: 'docs/a.md', content: '# hi' }],
        }),
      }).d,
    )(job(runId));
    expect(r).toMatchObject({ status: 'skipped', code: 'nothing_relevant' });
  });

  it('will not run a pass that is not pending, or that belongs to another workspace', async () => {
    const runId = await newRun();
    expect(await aiPassProcessor(deps().d)(job(runId, OTHER))).toMatchObject({
      status: 'skipped',
      code: 'not_found',
    });
    await aiPassProcessor(deps().d)(job(runId));
    expect(await aiPassProcessor(deps().d)(job(runId))).toMatchObject({
      status: 'skipped',
      code: 'already_started',
    });
  });

  it('never auto-resolves other findings: a finding the pass did not re-raise stays open', async () => {
    const bystander = await ruleFinding({ file: 'src/routes/users.ts', title: 'bystander' });
    const runId = await newRun();
    await aiPassProcessor(deps().d)(job(runId));
    const [f] = await db
      .select({ status: read.findings.status })
      .from(read.findings)
      .where(eq(read.findings.id, bystander));
    expect(f!.status).toBe('open');
  });
});

// OPT-IN: a REAL model. A pass makes several calls, and a reasoning model takes
// minutes for each, so this is not part of the gate. Run it with
//   AI_PASS_LIVE_MODEL=<loaded model id> pnpm vitest run apps/api/src/workers/ai-pass-processor.test.ts -t live
describeIfLiveInfra('the AI pass against a real model (opt-in)', () => {
  const MODEL = process.env.AI_PASS_LIVE_MODEL;
  it.skipIf(!MODEL)(
    'live: specialists and triage through the real routing chain on a small module',
    async () => {
      const db = createDb(databaseUrl as string);
      const host = {
        baseUrl: process.env.AI_PASS_LIVE_URL ?? 'http://localhost:1234/v1',
        modelSlot: MODEL!,
        providerId: 1,
        name: 'LM Studio',
        contextWindow: 262144,
      } as T2Host;
      const gateway = createAnalysisGateway({ hosts: [host] });
      await db
        .insert(core.workspaces)
        .values({ slug: 'w19-09-live', name: 'live' })
        .onConflictDoNothing();
      const ws = (
        await db
          .select({ id: core.workspaces.id })
          .from(core.workspaces)
          .where(eq(core.workspaces.slug, 'w19-09-live'))
          .limit(1)
      )[0]!.id;
      await db
        .insert(core.users)
        .values({
          authProvider: 'local',
          authSubject: 'w19-09-live@example.test',
          login: 'live',
          email: 'w19-09-live@example.test',
        })
        .onConflictDoNothing();
      const userId = (
        await db
          .select({ id: core.users.id })
          .from(core.users)
          .where(eq(core.users.authSubject, 'w19-09-live@example.test'))
          .limit(1)
      )[0]!.id;
      const enc = credentials.encryptCredential('live', Buffer.alloc(32, 7));
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
          forgeRepoId: 'w19-09-live',
          org: 'live',
          name: 'live',
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
      const [f] = await db
        .insert(read.findings)
        .values({
          workspaceId: ws,
          repoId: repo!.id,
          scanRunId: sr!.id,
          dimension: 'sast',
          severity: 4,
          confidence: 4,
          title: 'SQL built by concatenation',
          scannerKey: 'semgrep',
          ruleId: 'bpm-sql-built-variable',
          file: 'src/routes/users.ts',
          lineStart: 3,
          lineEnd: 3,
          evidence: 'db.query("SELECT * FROM users WHERE id = " + req.params.id)',
          recommendation: 'parameterise',
          tier: 2,
          dedupKey: 'w19-09-live-1',
          status: 'open',
          effectiveRisk: '80.00',
          contextLines: FILES[0]!.content,
          contextStartLine: 1,
        })
        .returning({ id: read.findings.id });
      const [run] = await db
        .insert(read.aiPassRuns)
        .values({ workspaceId: ws, repoId: repo!.id, paths: ['src'] })
        .returning({ id: read.aiPassRuns.id });
      try {
        const out = await aiPassProcessor({
          db,
          maxCalls: 4,
          gatewayFor: async () => ({ gateway, hosts: [host] }),
          loadSources: async () => ({ ok: true, commitSha: 'live0001', files: FILES }),
        })({ data: { workspaceId: ws, runId: run!.id } } as Job<AiPassJobData>);
        const row = (
          await db.select().from(read.aiPassRuns).where(eq(read.aiPassRuns.id, run!.id))
        )[0]!;
        const verdicts = await db
          .select()
          .from(read.aiTriageVerdicts)
          .where(eq(read.aiTriageVerdicts.findingId, f!.id));
        const found = await db
          .select({ dimension: read.findings.dimension, title: read.findings.title })
          .from(read.findings)
          .where(and(eq(read.findings.workspaceId, ws), isNull(read.findings.scannerKey)));
        // vitest's reporter swallows console output here, so the evidence goes to a file.
        const report = JSON.stringify(
          {
            out,
            status: row.status,
            reason: row.reason,
            calls: row.calls,
            specialists: (row.specialists as { usage?: unknown } | null)?.usage,
            dropped: (row.specialists as { droppedForBudget?: unknown } | null)?.droppedForBudget,
            triageFunnel: row.triageFunnel,
            triageSkipped: row.triageSkipped,
            verdicts: verdicts.map((v) => ({
              verdict: v.verdict,
              confidence: v.confidence,
              citations: v.citations,
              rationale: v.rationale.slice(0, 160),
              model: v.model,
              route: v.route,
            })),
            specialistFindings: found,
          },
          null,
          1,
        );
        if (process.env.AI_PASS_LIVE_OUT) writeFileSync(process.env.AI_PASS_LIVE_OUT, report);
        expect(out.status).toBe('succeeded');
        expect(
          (
            await db
              .select({ status: read.findings.status })
              .from(read.findings)
              .where(eq(read.findings.id, f!.id))
          )[0]!.status,
        ).toBe('open');
      } finally {
        await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, ws));
        await db
          .delete(read.aiFindingProvenance)
          .where(eq(read.aiFindingProvenance.workspaceId, ws));
        await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, ws));
        await db.delete(read.findings).where(eq(read.findings.workspaceId, ws));
        await db.delete(read.analysisRuns).where(eq(read.analysisRuns.workspaceId, ws));
        await db.delete(security.scanRuns).where(eq(security.scanRuns.id, sr!.id));
        await db.delete(core.repos).where(eq(core.repos.id, repo!.id));
        await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, conn!.id));
        await db.delete(core.workspaces).where(eq(core.workspaces.id, ws));
        await db.$client.end();
      }
    },
    40 * 60_000,
  );
});

describe('inScope', () => {
  it('matches a file or a directory prefix, and not a sibling with the same start', () => {
    expect(inScope('src/a.ts', ['src'])).toBe(true);
    expect(inScope('src/a.ts', ['src/a.ts'])).toBe(true);
    expect(inScope('src/a.ts', ['src/'])).toBe(true);
    expect(inScope('srcs/a.ts', ['src'])).toBe(false);
    expect(inScope('lib/a.ts', ['src'])).toBe(false);
  });
});
