import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { core, createDb, read, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import {
  NO_INDEPENDENT_HOST,
  OFF_NETWORK_NOT_ALLOWED,
  type AnalysisGateway,
  type CompleteOpts,
  type T2Host,
  type VerifyRequest,
} from '@repopulse/analysis';
import { dedupKey, persistFindings } from '@repopulse/insights';
import { runVerifyPass, type VerifyCandidate, type VerifyRunResult } from '@repopulse/security';
import { monthlyCallsUsed } from './ai-pass-scheduler.js';
import {
  AI_OFF_REASON,
  CAP_REASON,
  createSecondModelVerifier,
  cveVerifyHook,
} from './second-model.js';

// W21-03: the second-model verify as the worker runs it, against the real
// tables: AI off stops it, it counts against (and stops at) the monthly cap, an
// off-network connection needs the Tier-3 opt-in and local-only off, and the
// verifier is never the finder.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const REQ: VerifyRequest = {
  title: 'SQL built from a parameter',
  evidenceQuote: 'db.query("SELECT " + id)',
  file: 'src/a.ts',
  severity: 4,
  dimension: 'security',
  rationale: 'concatenated',
  excerpt: 'const id = req.params.id;\ndb.query("SELECT " + id);',
  finder: { providerId: 0, model: 'finder-model' },
};

describeIfLiveInfra('the second-model verifier (W21-03)', () => {
  const db = createDb(databaseUrl as string);
  let WS = 0;
  let REPO = 0;
  let connectionId = 0;
  let scanRunId = 0;
  const P: Record<'finder' | 'lan' | 'hosted', number> = { finder: 0, lan: 0, hosted: 0 };
  let hosts: T2Host[] = [];
  const sent: { providerId: number; prompt: string; opts: CompleteOpts }[] = [];
  let answer = '{"refuted":true,"reason":"validated upstream"}';

  const pinned = async (pin: { providerId: number; model: string }) => ({
    gateway: {
      async complete(prompt: string, opts: CompleteOpts) {
        sent.push({ providerId: pin.providerId, prompt, opts });
        return {
          text: answer,
          model: pin.model,
          tokensIn: 50,
          tokensOut: 10,
          costUsd: null,
          durationMs: 1,
        };
      },
      async health() {
        return { ok: true };
      },
    } satisfies AnalysisGateway,
  });

  const verifier = (over: Partial<Parameters<typeof createSecondModelVerifier>[0]> = {}) =>
    createSecondModelVerifier({
      db,
      workspaceId: WS,
      repoId: REPO,
      hosts,
      ledger: 'own',
      pinned,
      ...over,
    });

  async function settings(patch: { cap?: number; paused?: boolean }) {
    await db
      .insert(read.aiPassSettings)
      .values({
        workspaceId: WS,
        monthlyCallCap: patch.cap ?? 300,
        aiPaused: patch.paused ?? false,
      })
      .onConflictDoUpdate({
        target: read.aiPassSettings.workspaceId,
        set: { monthlyCallCap: patch.cap ?? 300, aiPaused: patch.paused ?? false },
      });
  }

  beforeAll(async () => {
    await db
      .insert(core.workspaces)
      .values({ slug: 'w21-03-ws', name: 'W21-03' })
      .onConflictDoNothing();
    WS = (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, 'w21-03-ws'))
    )[0]!.id;
    const enc = credentials.encryptCredential('w21-03-fixture-token', Buffer.alloc(32, 7));
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
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = conn!.id;
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId: WS,
        connectionId,
        forgeRepoId: 'w21-03-repo',
        org: 'w21-03',
        name: 'repo',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    REPO = repo!.id;
    const rows = await db
      .insert(core.llmProviders)
      .values([
        {
          workspaceId: WS,
          name: 'Finder box',
          kind: 'openai_compatible',
          baseUrl: 'http://10.0.0.5:1234/v1',
          model: 'finder-model',
        },
        {
          workspaceId: WS,
          name: 'Second box',
          kind: 'openai_compatible',
          baseUrl: 'http://10.0.0.6:1234/v1',
          model: 'second-model',
        },
        {
          workspaceId: WS,
          name: 'Hosted',
          kind: 'openai_compatible',
          baseUrl: 'https://api.example-hosted.com/v1',
          model: 'hosted-model',
          allowPublicHost: true,
        },
      ])
      .returning({
        id: core.llmProviders.id,
        name: core.llmProviders.name,
        baseUrl: core.llmProviders.baseUrl,
        model: core.llmProviders.model,
      });
    P.finder = rows[0]!.id;
    P.lan = rows[1]!.id;
    P.hosted = rows[2]!.id;
    hosts = rows.map((r) => ({
      baseUrl: r.baseUrl!,
      modelSlot: r.model,
      name: r.name,
      providerId: r.id,
    }));
    const [sr] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId: WS,
        repoId: REPO,
        scannerKey: 'dependency_cve',
        scannerVersion: 'test',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning({ id: security.scanRuns.id });
    scanRunId = sr!.id;
  });

  beforeEach(async () => {
    sent.length = 0;
    answer = '{"refuted":true,"reason":"validated upstream"}';
    await settings({});
    await db.delete(core.llmRoutingPolicy).where(eq(core.llmRoutingPolicy.workspaceId, WS));
    await db.update(core.repos).set({ tier3OptIn: false }).where(eq(core.repos.id, REPO));
    await db.delete(read.analysisRuns).where(eq(read.analysisRuns.workspaceId, WS));
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.workspaceId, WS));
    await db.delete(read.analysisRuns).where(eq(read.analysisRuns.workspaceId, WS));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, WS));
    await db.delete(core.llmRoutingPolicy).where(eq(core.llmRoutingPolicy.workspaceId, WS));
    await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, WS));
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, WS));
    await db.delete(core.repos).where(eq(core.repos.id, REPO));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, WS));
    await db.$client.end();
  });

  const req = (): VerifyRequest => ({
    ...REQ,
    finder: { providerId: P.finder, model: 'finder-model' },
  });

  it('asks a different, local connection, refute-first, and records the calls on the monthly cap', async () => {
    const before = await monthlyCallsUsed(db, WS, new Date());
    const v = verifier();
    const out = await v.verify(req());
    expect(out).toEqual({
      refuted: true,
      reason: 'validated upstream',
      verifier: { model: 'second-model', providerId: P.lan, connection: 'Second box' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.providerId).toBe(P.lan);
    expect(sent[0]!.prompt).toContain('REFUTE');
    expect(sent[0]!.opts).toMatchObject({
      tier: 'T2',
      maxTokens: 45_000,
      meta: { role: 'triage' },
    });
    await v.finish();
    const [row] = await db
      .select()
      .from(read.analysisRuns)
      .where(and(eq(read.analysisRuns.workspaceId, WS), eq(read.analysisRuns.passKind, 'verify')));
    expect(row).toMatchObject({ chunkCount: 1, modelId: 'second-model', repoId: REPO });
    expect(await monthlyCallsUsed(db, WS, new Date())).toBe(before + 1);
  });

  it('AI off stops it: nothing is sent', async () => {
    await settings({ paused: true });
    expect(await verifier().verify(req())).toEqual({ unverified: true, reason: AI_OFF_REASON });
    expect(sent).toEqual([]);
  });

  it('stops at the monthly cap', async () => {
    const used = await monthlyCallsUsed(db, WS, new Date());
    await settings({ cap: used + 1 });
    const v = verifier();
    expect('refuted' in (await v.verify(req()))).toBe(true);
    expect(await v.verify(req())).toEqual({ unverified: true, reason: CAP_REASON });
    expect(sent).toHaveLength(1);
  });

  it('goes off the network only on a Tier-3 opted-in repository with local-only off', async () => {
    const only = hosts.filter((h) => h.providerId !== P.lan);
    expect(await verifier({ hosts: only }).verify(req())).toEqual({
      unverified: true,
      reason: OFF_NETWORK_NOT_ALLOWED,
    });
    await db.update(core.repos).set({ tier3OptIn: true }).where(eq(core.repos.id, REPO));
    const out = await verifier({ hosts: only }).verify(req());
    expect(out).toMatchObject({ verifier: { providerId: P.hosted } });
    await db.insert(core.llmRoutingPolicy).values({ workspaceId: WS, localOnly: true });
    expect(await verifier({ hosts: only }).verify(req())).toEqual({
      unverified: true,
      reason: OFF_NETWORK_NOT_ALLOWED,
    });
    expect(sent.map((s) => s.providerId)).toEqual([P.hosted]);
  });

  it('never asks the finder: one connection alone means no second opinion', async () => {
    const only = hosts.filter((h) => h.providerId === P.finder);
    expect(await verifier({ hosts: only }).verify(req())).toEqual({
      unverified: true,
      reason: NO_INDEPENDENT_HOST,
    });
    expect(sent).toEqual([]);
  });

  it('an answer that cannot be read leaves it unverified (and the call still counts)', async () => {
    answer = 'Looks right to me!';
    const v = verifier();
    const out = await v.verify(req());
    expect(out).toMatchObject({ unverified: true });
    expect(v.calls()).toBe(1);
  });

  it('the CVE hook records V5 answers as verdicts: applies=false marks contradicted, nothing dismissed', async () => {
    const f = {
      dimension: 'dependency',
      severity: 4,
      confidence: 4,
      file: 'package-lock.json',
      lineStart: null,
      lineEnd: null,
      title: 'lodash 4.17.20: CVE-2021-23337',
      evidenceQuote: 'lodash@4.17.20 CVE-2021-23337',
      rationale: 'matched',
      suggestedFix: null,
      scannerKey: 'dependency_cve',
      ruleId: 'CVE-2021-23337',
    };
    await persistFindings(db, {
      workspaceId: WS,
      repoId: REPO,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings: [f],
    });
    const key = dedupKey({ ...f, scannerKey: f.scannerKey, ruleId: f.ruleId });
    let limit = -1;
    const fakeRun = (async (deps: Parameters<typeof runVerifyPass>[0]) => {
      limit = deps.limit ?? -1;
      return {
        status: 'succeeded',
        analysisRunId: null,
        scanRunId,
        checklistVersion: 'v',
        models: ['second-model'],
        proposals: [
          {
            dedupKey: key,
            primaryId: 'CVE-2021-23337',
            packageName: 'lodash',
            packageVersion: '4.17.20',
            applies: false,
            confidence: 4,
            model: 'second-model',
            proposal: {
              status: 'not_affected',
              justification: 'vulnerable_code_not_in_execute_path',
              statement: 'template() is never called',
            },
            citedEvidence: [],
          },
        ],
        rejections: [],
        funnel: { verified: 1, skipped: { already_verified: 0 } },
        partial: false,
        promptTokens: 0,
        outputTokens: 0,
      };
    }) as unknown as typeof runVerifyPass;
    const hook = cveVerifyHook({
      db,
      workspaceId: WS,
      repoId: REPO,
      verifier: verifier(),
      runVerify: fakeRun,
    });
    const summary = await hook({ candidates: [], scanRunId, commitSha: 'abc' });
    expect(summary).toMatchObject({ asked: 1, contradicted: 1, confirmed: 0 });
    expect(limit).toBe(10);
    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.workspaceId, WS), eq(read.findings.dedupKey, key)));
    expect(row).toMatchObject({
      status: 'open',
      verifyStatus: 'contradicted',
      verifiedByModel: 'second-model',
      verifyReason: 'template() is never called',
    });
  });

  it('W27-03: the CVE hook never asks the same question twice; a version bump is asked again', async () => {
    const f = {
      dimension: 'dependency',
      severity: 4,
      confidence: 4,
      file: 'yarn.lock',
      lineStart: null,
      lineEnd: null,
      title: 'CVE-2020-8203 in lodash 4.17.15',
      evidenceQuote: 'pkg:npm/lodash@4.17.15 is affected by CVE-2020-8203',
      rationale: 'matched',
      suggestedFix: null,
      scannerKey: 'dependency_cve',
      ruleId: 'CVE-2020-8203',
    };
    await persistFindings(db, {
      workspaceId: WS,
      repoId: REPO,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings: [f],
    });
    const key = dedupKey({ ...f, scannerKey: f.scannerKey, ruleId: f.ruleId });
    const cand = (version: string): VerifyCandidate => ({
      dedupKey: key,
      effectiveRisk: 8,
      vulnerability: {
        primaryId: 'CVE-2020-8203',
        aliases: [],
        cveId: 'CVE-2020-8203',
        packageName: 'lodash',
        packageVersion: version,
        packageType: 'npm',
        purl: `pkg:npm/lodash@${version}`,
        severity: 4,
        severityLabel: 'high',
        kev: false,
        epss: null,
        fixVersions: [],
        locations: ['yarn.lock'],
        matchType: 'exact-direct-match',
        scope: {
          inResolvedSet: true,
          versionMatches: true,
          scope: { kind: 'prod-direct', depth: 1 },
          manifest: 'yarn.lock',
          unreadableReason: null,
        },
        usage: { status: 'imported', unknownReason: null, evidence: [] },
        reachability: {
          tier: 'manifest_only',
          provenBy: null,
          unavailableReason: 'no prover',
          callSites: [],
        },
        proposals: [],
      },
    });
    answer = JSON.stringify({
      applies: true,
      justification: null,
      confidence: 3,
      reason: 'lodash is imported.',
      evidence: [],
    });
    let last: VerifyRunResult | null = null;
    const hook = cveVerifyHook({
      db,
      workspaceId: WS,
      repoId: REPO,
      verifier: verifier(),
      runVerify: async (d) => (last = await runVerifyPass(d)),
    });

    expect(await hook({ candidates: [cand('4.17.15')], scanRunId, commitSha: 'c1' })).toMatchObject(
      { asked: 1, confirmed: 1, alreadyVerified: 0 },
    );
    expect(sent).toHaveLength(1);

    // A new commit, unchanged manifests: the same question is not asked again.
    expect(await hook({ candidates: [cand('4.17.15')], scanRunId, commitSha: 'c2' })).toMatchObject(
      { asked: 0, alreadyVerified: 1 },
    );
    expect(sent).toHaveLength(1);
    expect(last!.funnel.skipped.already_verified).toBe(1);

    // Same finding row (the dedup key carries no version), new version: asked.
    expect(await hook({ candidates: [cand('4.17.19')], scanRunId, commitSha: 'c3' })).toMatchObject(
      { asked: 1, alreadyVerified: 0 },
    );
    expect(sent).toHaveLength(2);
    const [row] = await db
      .select({ yields: read.findings.yields, verifyStatus: read.findings.verifyStatus })
      .from(read.findings)
      .where(and(eq(read.findings.workspaceId, WS), eq(read.findings.dedupKey, key)));
    expect(row!.verifyStatus).toBe('confirmed');
    expect(row!.yields).toMatchObject({ verified_subject: 'CVE-2020-8203|lodash|4.17.19' });
  });

  it('the CVE hook asks nobody when AI is off', async () => {
    await settings({ paused: true });
    const hook = cveVerifyHook({
      db,
      workspaceId: WS,
      repoId: REPO,
      verifier: verifier(),
      runVerify: (() => {
        throw new Error('must not run');
      }) as never,
    });
    expect(await hook({ candidates: [], scanRunId, commitSha: 'abc' })).toEqual({
      asked: 0,
      confirmed: 0,
      contradicted: 0,
      refused: AI_OFF_REASON,
    });
  });
});
