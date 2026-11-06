import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import type { Job } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { core, createDb, facts, read, security } from '@repopulse/shared';
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
import { forgeDiffSources, addedRanges, overlaps, type LoadedDiff } from './ai-pass-diff.js';
import type { ForgeDiffFile, ForgeProvider } from '@repopulse/forge';
import {
  aiPassProcessor,
  inScope,
  PassCancelledError,
  trackPassGateway,
  type AiPassDeps,
  type AiPassJobData,
  type PassFile,
} from './ai-pass-processor.js';
import { queueFirstLookAfterScan, rankFirstLookPaths, rankPaths } from './ai-first-look.js';
import type { PassEgress } from '../lib/ai-pass-egress.js';

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
  let IDENT = 0;

  async function clear() {
    for (const w of [WS, OTHER]) {
      if (!w) continue;
      await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, w));
      await db.delete(read.aiFindingProvenance).where(eq(read.aiFindingProvenance.workspaceId, w));
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, w));
    }
    if (REPO) {
      await db.delete(facts.pullRequests).where(eq(facts.pullRequests.repoId, REPO));
      await db.delete(facts.commits).where(eq(facts.commits.repoId, REPO));
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
    const ident = {
      workspaceId: WS,
      provider: 'github',
      forgeLogin: 'w19-11-dev',
      displayName: 'W19-11 dev',
    };
    await db.insert(core.identities).values(ident).onConflictDoNothing();
    IDENT = (
      await db
        .select({ id: core.identities.id })
        .from(core.identities)
        .where(
          and(eq(core.identities.workspaceId, WS), eq(core.identities.forgeLogin, 'w19-11-dev')),
        )
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
    await db.delete(core.identities).where(eq(core.identities.id, IDENT));
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

  it('a cancel during a model call aborts that call (W25-06)', async () => {
    // 0.2.0 install: cancelled judges went on writing verdicts 15-23 minutes
    // later and held the one LM Studio slot the whole time.
    const runId = await newRun();
    await db
      .update(read.aiPassRuns)
      .set({ status: 'running' })
      .where(eq(read.aiPassRuns.id, runId));
    let seen: AbortSignal | undefined;
    const inner: AnalysisGateway = {
      complete: (_p, o) => {
        seen = o.signal;
        return new Promise((_resolve, reject) => {
          o.signal?.addEventListener('abort', () => reject(o.signal!.reason));
        });
      },
      health: async () => ({ ok: true }),
    };
    const tracked = trackPassGateway(inner, db, { workspaceId: WS, runId }, 0, 20);
    const call = tracked.complete('p', {
      tier: 'T2',
      maxTokens: 1,
      expectJson: true,
      meta: {
        repoId: '1',
        prNumber: 0,
        dimension: 'security',
        checklistVersion: 'v',
        initiator: 't',
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen?.aborted).toBe(false);
    // What POST .../cancel does to the row.
    await db
      .update(read.aiPassRuns)
      .set({ status: 'failed', reasonCode: 'cancelled' })
      .where(eq(read.aiPassRuns.id, runId));
    await expect(call).rejects.toBeInstanceOf(PassCancelledError);
    expect(seen?.aborted).toBe(true);
  });

  describe('the first look after a first scan (W25-01)', () => {
    const local: () => Promise<PassEgress> = async () => ({
      local_only: false,
      destinations: [
        {
          provider_id: 1,
          provider_name: 'LM Studio',
          host: '10.0.0.5',
          leaves_network: false,
          roles: ['security'],
        },
      ],
      leaves_network: false,
      digest: 'local',
      sentence: 'test',
    });
    const hosted: () => Promise<PassEgress> = async () => ({
      ...(await local()),
      leaves_network: true,
      digest: 'hosted',
    });
    const queueIt = (egress = local) => {
      const enqueued: { runId: number; maxCalls: number }[] = [];
      return queueFirstLookAfterScan(
        {
          db,
          config: { enabled: true },
          egress,
          enqueue: async (d) => {
            enqueued.push(d);
          },
        },
        { workspaceId: WS, repoId: REPO },
      ).then((r) => ({ ...r, enqueued }));
    };

    it('queues ONE first-look pass after the first scan on a local model, and not again', async () => {
      const first = await queueIt();
      expect(first.queued).toBe(true);
      expect(first.enqueued).toHaveLength(1);
      expect(first.enqueued[0]!.maxCalls).toBeGreaterThan(0);
      const run = await runOf(first.enqueued[0]!.runId);
      expect(run).toMatchObject({ mode: 'paths', trigger: 'after_scan', status: 'pending' });
      expect(await queueIt()).toMatchObject({ queued: false, code: 'already_done' });
      // Done is done: a succeeded first look is never repeated.
      await db
        .update(read.aiPassRuns)
        .set({ status: 'succeeded' })
        .where(eq(read.aiPassRuns.id, run.id));
      expect(await queueIt()).toMatchObject({ queued: false, code: 'already_done' });
    });

    it('a hosted model needs the repository opted in; the server switch turns it off', async () => {
      expect(await queueIt(hosted)).toMatchObject({ queued: false, code: 'not_opted_in' });
      const off = await queueFirstLookAfterScan(
        { db, config: { enabled: false }, egress: local, enqueue: async () => {} },
        { workspaceId: WS, repoId: REPO },
      );
      expect(off).toMatchObject({ queued: false, code: 'disabled' });
    });

    it('ranks the files with the most open findings first, then churn; reads them in rank order', async () => {
      await ruleFinding({ file: 'src/b.ts', severity: 2 });
      await ruleFinding({ file: 'src/a.ts', severity: 5 });
      await ruleFinding({ file: 'src/a.ts', severity: 4 });
      await ruleFinding({ file: 'package-lock.json', severity: 5 });
      await ruleFinding({ file: 'src/shadow.ts', severity: 5, experimental: true });
      const ranked = await rankFirstLookPaths(db, WS, REPO, new Date());
      expect(ranked).toEqual(['src/a.ts', 'src/b.ts']);

      const { enqueued } = await queueIt();
      const runId = enqueued[0]!.runId;
      const seen: { paths: string[]; fit?: boolean }[] = [];
      const { d, gw } = deps({
        rankFirstLook: ({ workspaceId, repoId }) =>
          rankFirstLookPaths(db, workspaceId, repoId, new Date()),
        loadSources: async ({ paths, fit }) => {
          seen.push({ paths, ...(fit !== undefined ? { fit } : {}) });
          return { ok: true, commitSha: 'abcdef1234567890', files: FILES };
        },
      });
      const r = await aiPassProcessor(d)(job(runId));
      expect(r.status).toBe('succeeded');
      expect(seen).toEqual([{ paths: ['src/a.ts', 'src/b.ts'], fit: true }]);
      expect(gw.calls.length).toBeGreaterThan(0);
      // The row names exactly the files that were read.
      expect((await runOf(runId)).paths).toEqual(FILES.map((f) => f.path));
    });

    it('nothing to rank is a skip with the reason, and no model call', async () => {
      const { enqueued } = await queueIt();
      const { d, gw } = deps({ rankFirstLook: async () => [] });
      const r = await aiPassProcessor(d)(job(enqueued[0]!.runId));
      expect(r).toMatchObject({ status: 'skipped', code: 'nothing_to_rank' });
      expect(gw.calls).toHaveLength(0);
    });

    it("waits for the repository's scans like the judge, so it ranks this scan's findings", async () => {
      const { enqueued } = await queueIt();
      const requeued: number[] = [];
      const { d, gw } = deps({
        rankFirstLook: async () => ['src/routes/users.ts'],
        judge: {
          scansPending: async () => true,
          requeue: async (data) => {
            requeued.push(data.runId);
          },
        },
      });
      const r = await aiPassProcessor(d)(job(enqueued[0]!.runId));
      expect(r).toMatchObject({ status: 'skipped', code: 'waiting_for_scans' });
      expect(requeued).toEqual([enqueued[0]!.runId]);
      expect(gw.calls).toHaveLength(0);
      expect((await runOf(enqueued[0]!.runId)).status).toBe('pending');
    });
  });

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
      // W20-25 (UX_TODO X-10): which connection answered, as a column.
      connectionName: 'LM Studio',
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
    expect((await runOf(runId)).reason).toMatch(/Add one in Settings → Models/);
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

  it("honours a lower call cap carried by the job (what is left of the scheduler's month)", async () => {
    await ruleFinding();
    const runId = await newRun(['src']);
    const { d, gw } = deps();
    await aiPassProcessor(d)({
      data: { workspaceId: WS, runId, maxCalls: 2 },
    } as Job<AiPassJobData>);
    expect(gw.calls.length).toBeLessThanOrEqual(2);
    expect((await runOf(runId)).calls).toBeLessThanOrEqual(2);
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

  it('W20-06 (UX_TODO AI-59): a pass where every specialist answered malformed JSON is FAILED with the reason, and the failures are kept', async () => {
    const base = scripted();
    const garbage: AnalysisGateway = {
      ...base.gateway,
      async complete(prompt: string, o: CompleteOpts): Promise<CompleteResult> {
        const r = await base.gateway.complete(prompt, o);
        return { ...r, text: 'Sure! Here is my review: it looks fine.' };
      },
    };
    const runId = await newRun();
    const r = await aiPassProcessor(deps({}, { gateway: garbage, calls: base.calls }).d)(
      job(runId),
    );
    expect(r).toMatchObject({ status: 'failed', code: 'specialists_unusable' });
    const run = await runOf(runId);
    expect(run.reason).toMatch(/reviewed nothing/);
    const failures = (run.specialists as { failures: { specialist: string; paths: string[] }[] })
      .failures;
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.paths).toContain('src/routes/users.ts');
  });

  // W20-11 (UX_TODO AI-60): a pass that fails partway keeps what it had done:
  // the specialists' model calls (they count toward the cap) and their usage.
  // W20-18 (UX_TODO AI-77): a pass queued just before AI was switched off sends
  // nothing; it is recorded as skipped with the reason.
  it('AI switched off after the pass was queued: skipped, nothing sent', async () => {
    await ruleFinding();
    const runId = await newRun();
    await db.insert(read.aiPassSettings).values({ workspaceId: WS, aiPaused: true });
    try {
      const gatewayFor = vi.fn(deps().d.gatewayFor);
      await aiPassProcessor(deps({ gatewayFor }).d)(job(runId));
      expect(gatewayFor).not.toHaveBeenCalled();
      expect(await runOf(runId)).toMatchObject({ status: 'skipped', reasonCode: 'ai_paused' });
    } finally {
      await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, WS));
    }
  });

  describe('a second opinion (W20-18, UX_TODO AI-14)', () => {
    async function setUp(baseUrl: string) {
      const findingId = await ruleFinding();
      const firstRun = await newRun();
      await db
        .update(read.aiPassRuns)
        .set({ status: 'succeeded' })
        .where(eq(read.aiPassRuns.id, firstRun));
      const [v] = await db
        .insert(read.aiTriageVerdicts)
        .values({
          workspaceId: WS,
          findingId,
          aiPassRunId: firstRun,
          verdict: 'likely_false_positive',
          confidence: 3,
          model: 'first-model',
          checklistVersion: 'triage.v1',
          rationale: 'r',
          citations: [],
        })
        .returning({ id: read.aiTriageVerdicts.id });
      const [prov] = await db
        .insert(core.llmProviders)
        .values({
          workspaceId: WS,
          name: 'Second',
          kind: 'openai_compatible',
          baseUrl,
          model: 'second-model',
          allowPublicHost: !baseUrl.startsWith('http://10.'),
        })
        .returning({ id: core.llmProviders.id });
      const [run] = await db
        .insert(read.aiPassRuns)
        .values({
          workspaceId: WS,
          repoId: REPO,
          paths: ['src/routes/users.ts'],
          mode: 'second_opinion',
          plan: {
            second_opinion: {
              verdict_id: v!.id,
              finding_id: findingId,
              provider_id: prov!.id,
              model: 'second-model',
            },
          },
        })
        .returning({ id: read.aiPassRuns.id });
      return { findingId, verdictId: v!.id, runId: run!.id };
    }
    const cleanProviders = () =>
      db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, WS));

    it('asks the pinned model once, stores the answer beside the first, and changes nothing else', async () => {
      try {
        const { findingId, verdictId, runId } = await setUp('http://10.0.0.6:1234/v1');
        const gw = scripted({ triageVerdict: 'real' });
        const pinned = vi.fn(async () => ({
          gateway: gw.gateway,
          hosts: [{ baseUrl: 'http://10.0.0.6:1234/v1', contextWindow: 32768 } as T2Host],
        }));
        const { d } = deps({ secondOpinionGatewayFor: pinned });
        const gatewayFor = vi.fn(d.gatewayFor);
        await aiPassProcessor({ ...d, gatewayFor })(job(runId));
        expect(pinned).toHaveBeenCalledWith(WS, expect.objectContaining({ model: 'second-model' }));
        expect(gatewayFor).not.toHaveBeenCalled();
        expect(gw.calls.map((c) => c.role)).toEqual(['triage']);
        expect(await runOf(runId)).toMatchObject({ status: 'succeeded', calls: 1 });
        const answers = await db
          .select()
          .from(read.aiTriageVerdicts)
          .where(eq(read.aiTriageVerdicts.findingId, findingId));
        expect(answers).toHaveLength(2);
        const second = answers.find((x) => x.secondOpinionOf === verdictId)!;
        expect(second).toMatchObject({ verdict: 'real', aiPassRunId: runId, decision: null });
        const [f] = await db.select().from(read.findings).where(eq(read.findings.id, findingId));
        expect(f!.status).toBe('open');
      } finally {
        await cleanProviders();
      }
    });

    it('re-checks the destination when it runs: off the network needs the Tier-3 opt-in', async () => {
      try {
        const { runId } = await setUp('https://api.example.com/v1');
        const pinned = vi.fn();
        await aiPassProcessor(deps({ secondOpinionGatewayFor: pinned }).d)(job(runId));
        expect(pinned).not.toHaveBeenCalled();
        expect(await runOf(runId)).toMatchObject({
          status: 'failed',
          reasonCode: 'tier3_not_opted_in',
        });
      } finally {
        await cleanProviders();
      }
    });
  });

  it('a pass that fails after the specialists ran keeps their calls and usage on the row', async () => {
    let modelCalled = false;
    let thrown = false;
    const gw = scripted({ onCall: () => (modelCalled = true) });
    const runId = await newRun();
    const r = await aiPassProcessor({
      ...deps({}, gw).d,
      // The first clock read after a model call is in the persistence step:
      // fail there once, as a crash partway through would.
      now: () => {
        if (modelCalled && !thrown) {
          thrown = true;
          throw new Error('The model has crashed without additional information.');
        }
        return new Date();
      },
    })(job(runId));
    expect(r).toMatchObject({ status: 'failed', code: 'error' });
    const run = await runOf(runId);
    expect(run.reason).toMatch(/crashed/);
    expect(run.calls).toBe(gw.calls.length);
    expect(run.calls).toBeGreaterThan(0);
    const usage = (run.specialists as { usage: Record<string, { findings: number }> }).usage;
    expect(Object.keys(usage).length).toBeGreaterThan(0);
  });

  // ----- W19-11: diff modes -------------------------------------------------

  const PATCH = [
    '@@ -0,0 +1,6 @@',
    '+export function register(app) {',
    "+  app.get('/u/:id', async (req, res) => {",
    '+    const rows = await db.query("SELECT * FROM users WHERE id = " + req.params.id);',
    '+    res.json(rows);',
    '+  });',
    '+}',
  ].join('\n');

  async function newDiffRun(
    over: Partial<typeof read.aiPassRuns.$inferInsert> = {},
    workspaceId = WS,
  ) {
    const [r] = await db
      .insert(read.aiPassRuns)
      .values({
        workspaceId,
        repoId: REPO,
        paths: [],
        mode: 'pull_request',
        prNumber: 7,
        ...over,
      })
      .returning({ id: read.aiPassRuns.id });
    return r!.id;
  }
  const okDiff = (over: Partial<Extract<LoadedDiff, { ok: true }>> = {}): LoadedDiff => ({
    ok: true,
    commitSha: 'headsha1234567',
    baseRef: 'main',
    headRef: 'headsha1234567',
    title: 'Pull request #7: Add users route',
    files: [{ path: 'src/routes/users.ts', patch: PATCH }],
    unreadable: [],
    ...over,
  });

  it('diff mode reviews the DIFF, labels the pass, and triages only rule findings on lines the change adds', async () => {
    const inside = await ruleFinding({ lineStart: 3, lineEnd: 3 });
    const farAway = await ruleFinding({ lineStart: 60, lineEnd: 60 });
    const otherFile = await ruleFinding({ file: 'lib/other.ts', lineStart: 3, lineEnd: 3 });
    const runId = await newDiffRun();
    const seen: unknown[] = [];
    const { d, gw } = deps({
      loadDiff: async (req) => {
        seen.push(req);
        return okDiff({ unreadable: ['assets/huge.json'] });
      },
      loadSources: async () => {
        throw new Error('a diff pass must not read the repository snapshot');
      },
    });
    const res = await aiPassProcessor(d)(job(runId));
    expect(res.status).toBe('succeeded');
    expect(seen[0]).toMatchObject({ mode: 'pull_request', prNumber: 7, repoId: REPO });

    // The specialists were shown the change, titled as the pull request.
    const specialistPrompt = gw.calls.find((c) => c.role !== 'triage')!.prompt;
    expect(specialistPrompt).toContain('Pull request #7: Add users route');
    expect(specialistPrompt).toContain('+    const rows = await db.query(');

    const run = await runOf(runId);
    expect(run.mode).toBe('pull_request');
    expect(run.baseRef).toBe('main');
    expect(run.headRef).toBe('headsha1234567');
    expect(run.commitSha).toBe('headsha1234567');
    // Files the forge could not give a full patch for are LISTED, not silently skipped.
    expect((run.specialists as { unreadable?: string[] }).unreadable).toEqual(['assets/huge.json']);

    const triaged = (
      await db
        .select({ id: read.aiTriageVerdicts.findingId })
        .from(read.aiTriageVerdicts)
        .where(eq(read.aiTriageVerdicts.workspaceId, WS))
    ).map((r) => r.id);
    expect(triaged).toEqual([inside]);
    expect(triaged).not.toContain(farAway);
    expect(triaged).not.toContain(otherFile);
    // And nothing was dismissed or resolved.
    const [f] = await db.select().from(read.findings).where(eq(read.findings.id, inside));
    expect(f!.status).toBe('open');
  });

  it('a commit-range pass passes the base and head through and records them', async () => {
    const runId = await newDiffRun({
      mode: 'commit_range',
      prNumber: null,
      baseRef: 'aaaaaaa',
      headRef: 'bbbbbbb',
    });
    const seen: unknown[] = [];
    const { d } = deps({
      loadDiff: async (req) => {
        seen.push(req);
        return okDiff({ baseRef: 'aaaaaaa1', headRef: 'bbbbbbb1', commitSha: 'bbbbbbb1' });
      },
    });
    await aiPassProcessor(d)(job(runId));
    expect(seen[0]).toMatchObject({ mode: 'commit_range', base: 'aaaaaaa', head: 'bbbbbbb' });
    const run = await runOf(runId);
    expect(run.baseRef).toBe('aaaaaaa1');
    expect(run.headRef).toBe('bbbbbbb1');
  });

  it('records the loader’s named refusal, and fails by name where diff mode is not wired', async () => {
    const refused = await newDiffRun();
    await aiPassProcessor(
      deps({
        loadDiff: async () => ({
          ok: false,
          code: 'too_large',
          reason: 'That change is more than 40 files.',
        }),
      }).d,
    )(job(refused));
    const r1 = await runOf(refused);
    expect([r1.status, r1.reasonCode]).toEqual(['failed', 'too_large']);
    expect(r1.reason).toMatch(/more than 40 files/);

    const unwired = await newDiffRun();
    await aiPassProcessor(deps().d)(job(unwired));
    const r2 = await runOf(unwired);
    expect([r2.status, r2.reasonCode]).toEqual(['failed', 'no_diff_source']);
  });

  it('diff triage says why when no rule finding sits on the change', async () => {
    await ruleFinding({ lineStart: 60, lineEnd: 60 });
    const runId = await newDiffRun();
    await aiPassProcessor(deps({ loadDiff: async () => okDiff() }).d)(job(runId));
    const run = await runOf(runId);
    expect(run.triageFunnel).toBeNull();
    expect(run.triageSkipped).toMatch(/sits on lines this change adds or alters/);
  });

  describe('the diff loader', () => {
    const file = (path: string, over: Partial<ForgeDiffFile> = {}): ForgeDiffFile => ({
      path,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: `@@ -1,1 +1,2 @@\n x\n+y ${path}`,
      patchTruncated: false,
      ...over,
    });
    /** A file whose patch the forge did not send at all. */
    const noPatch = (path: string): ForgeDiffFile => ({
      path,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patchTruncated: false,
    });
    function forge(opts: { pr?: ForgeDiffFile[][]; commits?: Record<string, ForgeDiffFile[]> }) {
      const calls = { pr: 0, commit: [] as string[] };
      const provider = {
        kind: 'github',
        capabilities: {},
        async getPullRequestFiles(_ctx: unknown, _repo: string, _n: number, cursor?: string) {
          const page = Number(cursor ?? 0);
          calls.pr += 1;
          const items = opts.pr?.[page] ?? [];
          return page + 1 < (opts.pr?.length ?? 0)
            ? { items, nextCursor: String(page + 1) }
            : { items };
        },
        async getCommitFiles(_ctx: unknown, _repo: string, sha: string) {
          calls.commit.push(sha);
          return { items: opts.commits?.[sha] ?? [], stats: { additions: 0, deletions: 0 } };
        },
      } as unknown as ForgeProvider;
      return {
        calls,
        load: forgeDiffSources({
          db,
          forgeFor: async () => ({ provider, repoFullName: 'w19-09/repo' }),
        }),
      };
    }
    async function addPr(number = 7, headSha = 'h'.repeat(40)) {
      await db.insert(facts.pullRequests).values({
        workspaceId: WS,
        repoId: REPO,
        number,
        forgePrId: `pr-${number}`,
        title: 'Add users route',
        authorIdentityId: IDENT,
        state: 'open',
        isDraft: false,
        isBot: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        baseRef: 'main',
        headSha,
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      });
    }
    async function addCommit(sha: string, minutesAgo: number, isMerge = false) {
      await db.insert(facts.commits).values({
        workspaceId: WS,
        repoId: REPO,
        sha,
        authorIdentityId: IDENT,
        committerIdentityId: IDENT,
        authoredAt: new Date(Date.now() - minutesAgo * 60_000),
        committedAt: new Date(Date.now() - minutesAgo * 60_000),
        messageHead: 'x',
        isRevertHeuristic: false,
        isMerge,
      });
    }
    const req = { workspaceId: 0, repoId: 0 };
    beforeEach(() => {
      req.workspaceId = WS;
      req.repoId = REPO;
    });

    it('reads a pull request through the forge, across pages, skipping removed files and listing the unreadable', async () => {
      await addPr();
      const f = forge({
        pr: [
          [file('a.ts'), file('gone.ts', { status: 'removed' })],
          [noPatch('big.json'), file('b.ts', { patchTruncated: true })],
          [file('c.ts')],
        ],
      });
      const out = await f.load({ ...req, mode: 'pull_request', prNumber: 7 });
      if (!out.ok) throw new Error(out.reason);
      expect(out.files.map((x) => x.path)).toEqual(['a.ts', 'c.ts']);
      expect(out.unreadable).toEqual(['big.json', 'b.ts']);
      expect(out.title).toBe('Pull request #7: Add users route');
      expect(out.baseRef).toBe('main');
      expect(out.commitSha).toBe('h'.repeat(40));
      expect(f.calls.pr).toBe(3);
    });

    it('refuses a pull request that was never ingested, another workspace’s repo, and a change with nothing readable', async () => {
      const f = forge({ pr: [[noPatch('x.ts')]] });
      const none = await f.load({ ...req, mode: 'pull_request', prNumber: 99 });
      expect(none).toMatchObject({ ok: false, code: 'not_found' });
      expect(f.calls.pr).toBe(0); // checked against our warehouse before any forge call

      await addPr();
      const unreadable = await f.load({ ...req, mode: 'pull_request', prNumber: 7 });
      expect(unreadable).toMatchObject({ ok: false, code: 'no_files' });
      expect((unreadable as { reason: string }).reason).toMatch(/x\.ts/);

      const other = await f.load({
        workspaceId: OTHER,
        repoId: REPO,
        mode: 'pull_request',
        prNumber: 7,
      });
      expect(other).toMatchObject({ ok: false, code: 'not_found' });
    });

    it('refuses, rather than truncates, a change over the file or byte cap', async () => {
      await addPr();
      const many = Array.from({ length: 41 }, (_, i) => file(`f${i}.ts`));
      const tooMany = await forge({ pr: [many] }).load({
        ...req,
        mode: 'pull_request',
        prNumber: 7,
      });
      expect(tooMany).toMatchObject({ ok: false, code: 'too_large' });
      const huge = await forge({
        pr: [[file('big.ts', { patch: `@@ -0,0 +1,1 @@\n+${'x'.repeat(401_000)}` })]],
      }).load({ ...req, mode: 'pull_request', prNumber: 7 });
      expect(huge).toMatchObject({ ok: false, code: 'too_large' });
    });

    it('resolves a commit range from our own warehouse (oldest first, merges skipped) and reads each commit’s files', async () => {
      await addCommit('aaaaaaa0000000000000000000000000000000aa', 50);
      await addCommit('bbbbbbb0000000000000000000000000000000bb', 40);
      await addCommit('mmmmmmm0000000000000000000000000000000mm', 35, true);
      await addCommit('ccccccc0000000000000000000000000000000cc', 30);
      const f = forge({
        commits: {
          bbbbbbb0000000000000000000000000000000bb: [file('a.ts')],
          ccccccc0000000000000000000000000000000cc: [file('a.ts'), file('c.ts')],
        },
      });
      const out = await f.load({ ...req, mode: 'commit_range', base: 'aaaaaaa', head: 'ccccccc' });
      if (!out.ok) throw new Error(out.reason);
      expect(f.calls.commit).toEqual([
        'bbbbbbb0000000000000000000000000000000bb',
        'ccccccc0000000000000000000000000000000cc',
      ]);
      // The same path in two commits stays two entries: their line numbers differ.
      expect(out.files.map((x) => x.path)).toEqual(['a.ts', 'a.ts', 'c.ts']);
      expect(out.commits).toHaveLength(2);
      expect(out.baseRef).toBe('aaaaaaa0000000000000000000000000000000aa');
      expect(out.headRef).toBe('ccccccc0000000000000000000000000000000cc');
    });

    it('refuses an unknown commit, a reversed range and a range of more than ten commits', async () => {
      await addCommit('aaaaaaa0000000000000000000000000000000aa', 100);
      for (let i = 0; i < 11; i++) {
        await addCommit(`${(i + 1).toString(16).padStart(7, '0')}${'0'.repeat(33)}`, 90 - i);
      }
      const f = forge({});
      const unknown = await f.load({
        ...req,
        mode: 'commit_range',
        base: 'deadbee',
        head: 'aaaaaaa',
      });
      expect(unknown).toMatchObject({ ok: false, code: 'not_found' });
      const reversed = await f.load({
        ...req,
        mode: 'commit_range',
        base: '000000b',
        head: 'aaaaaaa',
      });
      expect(reversed).toMatchObject({ ok: false, code: 'bad_range' });
      const wide = await f.load({ ...req, mode: 'commit_range', base: 'aaaaaaa', head: '000000b' });
      expect(wide).toMatchObject({ ok: false, code: 'too_large' });
      expect(f.calls.commit).toEqual([]); // refused before any forge call
      const garbage = await f.load({ ...req, mode: 'commit_range', base: 'zz', head: 'aaaaaaa' });
      expect(garbage).toMatchObject({ ok: false, code: 'bad_range' });
    });
  });

  it('addedRanges lists the new-side lines a patch adds, and overlap finds a finding inside them', () => {
    const patch = [
      '@@ -1,4 +10,5 @@',
      ' keep',
      '-old',
      '+new a',
      '+new b',
      ' keep',
      '+tail',
      '@@ -40,2 +60,3 @@',
      ' ctx',
      '+added',
    ].join('\n');
    expect(addedRanges(patch)).toEqual([
      [11, 12],
      [14, 14],
      [61, 61],
    ]);
    const r = addedRanges(patch);
    expect(overlaps(r, 12, 13)).toBe(true);
    expect(overlaps(r, 13, 13)).toBe(false);
    expect(overlaps(r, 61, 70)).toBe(true);
    expect(overlaps(r, 1, 9)).toBe(false);
    expect(addedRanges('')).toEqual([]);
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

  it('W21-03: a second model judges what the specialists raised; a contradiction marks, never dismisses, and its calls count on the pass', async () => {
    const runId = await newRun();
    const asked: { finder: unknown; excerpt: string; maxCalls: number }[] = [];
    let verifyCalls = 0;
    const { d, gw } = deps({
      verifierFor: ({ maxCalls }) => ({
        verify: async (req) => {
          verifyCalls += 1;
          asked.push({ finder: req.finder, excerpt: req.excerpt, maxCalls });
          return {
            refuted: true,
            reason: 'the id is validated upstream',
            verifier: { model: 'judge-b', providerId: null, connection: 'Box B' },
          };
        },
        calls: () => verifyCalls,
      }),
    });
    const result = await aiPassProcessor(d)(job(runId));
    expect(result.status).toBe('succeeded');
    expect(verifyCalls).toBeGreaterThan(0);
    // Told who raised it (so it is someone else) and shown the code.
    expect(asked[0]!.finder).toEqual({ providerId: 1, model: 'scripted-model' });
    expect(asked[0]!.excerpt).toContain('db.query');
    // Only the calls the pass had left.
    expect(asked[0]!.maxCalls).toBeLessThanOrEqual(30 - gw.calls.length);

    const run = await runOf(runId);
    expect(run.calls).toBe(gw.calls.length + verifyCalls);
    expect((run.specialists as { verify: unknown }).verify).toMatchObject({
      asked: verifyCalls,
      contradicted: verifyCalls,
      confirmed: 0,
    });

    const [mine] = await db
      .select()
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, WS),
          eq(read.findings.title, 'security: SQL built from a parameter'),
        ),
      );
    expect(mine).toMatchObject({
      status: 'open',
      verifyStatus: 'contradicted',
      verifiedByModel: 'judge-b',
      verifiedByConnection: 'Box B',
      verifyReason: 'the id is validated upstream',
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

describe('rankPaths (W25-01)', () => {
  it('puts findings before churn, keeps readable source only, and drops duplicates', () => {
    expect(
      rankPaths(
        [
          { path: 'src/a.py', weight: 9 },
          { path: 'node_modules/x/index.js', weight: 8 },
          { path: 'README.md', weight: 7 },
          { path: 'go.mod', weight: 6 },
        ],
        [
          { path: 'src/a.py', weight: 50 },
          { path: './lib/b.go', weight: 40 },
          { path: 'web/app.min.js', weight: 30 },
        ],
      ),
    ).toEqual(['src/a.py', 'go.mod', 'lib/b.go']);
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, weight: 10 - i }));
    expect(rankPaths(many, [], 3)).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
  });
});
