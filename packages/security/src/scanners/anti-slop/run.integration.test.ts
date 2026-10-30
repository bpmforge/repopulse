import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import {
  buildVerifyPrompt,
  HostUnavailableError,
  pickVerifierHost,
  type AnalysisGateway,
  type CompleteOpts,
  type T2Host,
  type VerifyRequest,
} from '@repopulse/analysis';
import { dedupKey, readImportGraph } from '@repopulse/insights';
import { runAntiSlopScan, worstByLdr } from './run.js';
import { readSnapshotSources } from '../../snapshot/sources.js';

const DEP_FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/dep-hygiene',
);

// anti_slop (W9-03, CODE_HEALTH_SUITE.md §1/§4, FR-CH-3).
//
// The gateway is faked: what needs proving is the VERIFY GATE and the layer
// split, not what a local model happens to say about a wrapper.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const FP = 'w9-03-fp';

// The pull request's diff: since anti-slop.v2 a SCOPE (which files), never
// model input. Its content lines must not reach the prompt.
const PATCH = [
  '@@ -1,3 +1,5 @@',
  " import { fetchUser } from './api.js';",
  '+export function getUser(id: string) {',
  '+  return fetchUser(id);',
  '+}',
  " getUser('1');",
].join('\n');

// What the fast lane reads. getUser is a delegation-only wrapper: the one
// candidate the model is handed.
const SOURCES = [
  {
    path: 'src/accounts/api.ts',
    source: 'export function fetchUser(id: string) {\n  return { id };\n}',
  },
  {
    path: 'src/accounts/load.ts',
    source: [
      "import { fetchUser } from './api.js';",
      'export function getUser(id: string) {',
      '  return fetchUser(id);',
      '}',
      "getUser('1');",
    ].join('\n'),
  },
];

function judgment(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    findings: [
      {
        candidate: 'c1',
        dimension: 'code_health',
        severity: 4,
        confidence: 4,
        file: 'src/accounts/load.ts',
        line_range: [2, 4],
        title: 'Delegation-only wrapper: getUser',
        evidence_quote: '  return fetchUser(id);',
        rationale: 'The wrapper forwards its argument unchanged and returns the result.',
        suggested_fix: 'Call fetchUser directly.',
        preconditions: [],
        yields: [],
        ...over,
      },
    ],
  });
}
const JUDGMENT = judgment();

function fakeGateway(
  calls: CompleteOpts[],
  text = JUDGMENT,
  prompts: string[] = [],
  model = 'fake-finder',
): AnalysisGateway {
  return {
    async complete(prompt: string, opts: CompleteOpts) {
      calls.push(opts);
      prompts.push(prompt);
      return {
        text,
        model,
        tokensIn: 10,
        tokensOut: 5,
        costUsd: null,
        durationMs: 1,
      };
    },
    async health() {
      return { ok: true };
    },
  };
}

describeIfLiveInfra('anti_slop scanner (W9-03)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;

  const files = [{ path: 'src/accounts/load.ts', patch: PATCH, status: 'modified' as const }];

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w9-03-user',
        forgeUserId: 'w9-03-user',
        login: 'w9-03-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w9-03-user' } })
      .returning();
    userId = user!.id;

    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: FP,
        status: 'active',
        createdBy: userId,
      })
      .returning();

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w9-03-repo',
        org: 'acme',
        name: 'slop',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
  });

  afterAll(async () => {
    await db
      .delete(security.ruleRegistry)
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, workspaceId),
          inArray(security.ruleRegistry.ruleId, [
            'slop.unused_export',
            'slop.stale_jsdoc_param',
            'slop.unbounded_retry',
            'slop.suppression_density',
            'slop.exception_control_flow',
            'slop.repository_over_crud',
            'slop.stale_jsdoc_param',
            'slop.unbounded_retry',
            'test.tautology',
            'slop.duplicate_purpose_deps',
            'slop.library_reimplementation',
          ]),
        ),
      );
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  // The candidate fixture's deterministic rows (a shadow delegation wrapper)
  // would otherwise sit beside the W18-05 test's own and be read first.
  afterEach(async () => {
    await db
      .delete(read.findings)
      .where(
        and(
          eq(read.findings.repoId, repoId),
          inArray(read.findings.file, ['src/accounts/load.ts', 'src/accounts/api.ts']),
        ),
      );
  });

  it('a verifier-REFUTED judgement finding is stored open, marked contradicted (W21-03)', async () => {
    // The gate that matters. A structural claim is an accusation about
    // someone's code, and the product has to be able to be talked out of one —
    // by a person: a model's refutation marks the finding, it never dismisses it.
    const calls: CompleteOpts[] = [];
    const seen: VerifyRequest[] = [];
    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway(calls),
      workspaceId,
      repoId,
      commitSha: 'w9-03-refuted',
      files,
      sources: SOURCES,
      trigger: 'pr_synced',
      verify: async (req) => {
        seen.push(req);
        return {
          refuted: true,
          reason: 'the wrapper adds a retry',
          verifier: { model: 'second-model', providerId: null, connection: 'Second box' },
        };
      },
    });

    expect(result.status).toBe('succeeded');
    expect(result.refuted).toBe(1);
    expect(result.judgment).toBe(1);
    const rows = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'slop.judgment')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'open',
      verifyStatus: 'contradicted',
      verifiedByModel: 'second-model',
      verifiedByConnection: 'Second box',
      verifyReason: 'the wrapper adds a retry',
    });
    expect(rows[0]?.verifiedAt).toBeInstanceOf(Date);
    // The verifier was told who raised it and shown the candidate's code.
    expect(seen[0]?.finder.model).toBeTruthy();
    expect(seen[0]?.excerpt.length).toBeGreaterThan(0);
  });

  it('a verifier that could not be asked leaves the finding unverified, with why', async () => {
    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway([]),
      workspaceId,
      repoId,
      commitSha: 'w9-03-unasked',
      files,
      sources: SOURCES,
      trigger: 'pr_synced',
      verify: async () => ({ unverified: true, reason: 'No second AI connection.' }),
    });
    expect(result.unverified).toBe(1);
    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'slop.judgment')));
    expect(row).toMatchObject({
      verifyStatus: 'unverified',
      verifiedByModel: null,
      verifyReason: 'No second AI connection.',
    });
  });

  it('a CONFIRMED judgement finding is stored, capped at severity 3', async () => {
    const calls: CompleteOpts[] = [];
    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway(calls),
      workspaceId,
      repoId,
      commitSha: 'w9-03-confirmed',
      files,
      sources: SOURCES,
      trigger: 'pr_synced',
      verify: async () => ({ refuted: false, reason: 'confirmed: forwards unchanged' }),
    });

    expect(result.judgment).toBe(1);
    expect(result.refuted).toBe(0);
    // Accounting says which scanner spent the tokens.
    expect(calls[0]?.meta.initiator).toBe('scanner:anti_slop');
    expect(calls[0]?.meta.checklistVersion).toBe('anti-slop.v2');

    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'slop.judgment')));
    // The model said 4; structural slop is not exploitable, so it is capped.
    expect(row?.severity).toBe(3);
    expect(row?.tier).toBe(2);
    expect(row?.yields).toBeNull();
  });

  it('a busy model skips only the judgement: the run succeeds, partial, and keeps the rule findings', async () => {
    // 2026-10-30, outline: the weekly rule-tweak pass held LM Studio's one
    // slot, the gateway answered HostUnavailableError, and anti-slop failed
    // the whole run, throwing away its deterministic findings with it.
    const busy: AnalysisGateway = {
      async complete() {
        throw new HostUnavailableError();
      },
      async health() {
        return { ok: true };
      },
    };
    const result = await runAntiSlopScan({
      db,
      gateway: busy,
      workspaceId,
      repoId,
      commitSha: 'w9-03-model-busy',
      files,
      sources: SOURCES,
      trigger: 'pr_synced',
    });
    expect(result.status).toBe('succeeded');
    expect(result.judgment).toBe(0);
    expect(result.deterministic).toBeGreaterThan(0);
    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.id, result.scanRunId!));
    expect(run?.status).toBe('succeeded');
    expect(run?.partial).toBe(true);
    expect(run?.error).toMatch(/model was busy/);
  });

  it('with NO verifier available, the finding is stored as unverified', async () => {
    // Not dropped and not promoted: "nobody re-judged this" is the honest
    // state, and mayBeSurfacedLoudly keeps it off the loud surfaces.
    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway([]),
      workspaceId,
      repoId,
      commitSha: 'w9-03-unverified',
      files,
      sources: SOURCES,
      trigger: 'pr_synced',
    });
    expect(result.unverified).toBe(1);
    expect(result.judgment).toBe(1);
  });

  it('W18-10: the model is handed the fast-lane candidates with their evidence, never the diff', async () => {
    const calls: CompleteOpts[] = [];
    const prompts: string[] = [];
    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway(calls, JUDGMENT, prompts),
      workspaceId,
      repoId,
      commitSha: 'w18-10-handoff',
      files,
      sources: SOURCES,
      trigger: 'pr_synced',
      verify: async () => ({ refuted: false, reason: 'ok' }),
    });
    expect(result.status).toBe('succeeded');
    expect(result.candidates).toBe(1);
    expect(result.candidatesCapped).toBe(0);
    expect(result.judgment).toBe(1);
    expect(calls).toHaveLength(1);
    const [prompt] = prompts;
    // (file, line, rule, evidence), and the lines around it.
    expect(prompt).toContain('### c1 · slop.delegation_wrapper · src/accounts/load.ts:2');
    expect(prompt).toContain('Flagged: export function getUser(id: string) {');
    expect(prompt).toContain("Rule's claim: getUser only forwards its own parameters");
    expect(prompt).toContain('Lines 1-5 of src/accounts/load.ts:');
    // Not the diff: no hunk header, no +/- lines, no diff fence.
    expect(prompt).not.toContain('@@ -1,3 +1,5 @@');
    expect(prompt).not.toContain('+  return fetchUser(id);');
    expect(prompt).not.toContain('```diff');

    const [row] = await db
      .select()
      .from(read.findings)
      .where(
        and(
          eq(read.findings.repoId, repoId),
          eq(read.findings.ruleId, 'slop.judgment'),
          eq(read.findings.file, 'src/accounts/load.ts'),
        ),
      );
    expect(row).toMatchObject({ lineStart: 2, severity: 3, dimension: 'slop' });

    // A diff that touches none of the candidates' files: nothing to judge, no
    // call, even though the tree still has the wrapper.
    const outside: CompleteOpts[] = [];
    const scoped = await runAntiSlopScan({
      db,
      gateway: fakeGateway(outside),
      workspaceId,
      repoId,
      commitSha: 'w18-10-scoped',
      files: [{ path: 'src/accounts/api.ts', patch: '@@ -1 +1 @@\n-x\n+y' }],
      sources: SOURCES,
      trigger: 'pr_synced',
    });
    expect(scoped.candidates).toBe(0);
    expect(outside).toEqual([]);
  });

  it('W18-10: a finding about anything but a listed candidate is rejected, not stored', async () => {
    // The model went back to searching: api.ts is in no candidate's excerpt.
    const searching = judgment({
      candidate: undefined,
      file: 'src/accounts/api.ts',
      line_range: [1, 3],
      evidence_quote: 'return { id };',
      title: 'Single-use helper: fetchUser',
    });
    // The right place, but a second finding for the one candidate.
    const twice = JSON.stringify({
      findings: [JSON.parse(JUDGMENT).findings[0], JSON.parse(JUDGMENT).findings[0]],
    });
    const first = await runAntiSlopScan({
      db,
      gateway: fakeGateway([], searching),
      workspaceId,
      repoId,
      commitSha: 'w18-10-searching',
      files: [],
      sources: SOURCES,
      trigger: 'schedule',
    });
    expect(first).toMatchObject({ candidates: 1, judgment: 0, rejected: 1 });
    const second = await runAntiSlopScan({
      db,
      gateway: fakeGateway([], twice),
      workspaceId,
      repoId,
      commitSha: 'w18-10-twice',
      files: [],
      sources: SOURCES,
      trigger: 'schedule',
    });
    expect(second).toMatchObject({ candidates: 1, judgment: 1, rejected: 1 });
  });

  it('W18-10: maker != verifier — the candidate judge never verifies its own finding', async () => {
    // FR-ANALYSIS-9, unchanged by v2. The maker is one host; the verify hook
    // is wired the way a caller must wire it, through pickVerifierHost, and
    // every verification has to land on a DIFFERENT host. The maker gateway
    // must see only candidate prompts: one call per batch, no verify prompt.
    const makerHost: T2Host = { baseUrl: 'http://finder:1234', modelSlot: 'qwen' };
    const hosts: T2Host[] = [makerHost, { baseUrl: 'http://checker:1234', modelSlot: 'nemotron' }];
    const makerCalls: CompleteOpts[] = [];
    const makerPrompts: string[] = [];
    const verifiedOn: string[] = [];
    const verifyPrompts: string[] = [];
    const verifyVia =
      (pool: readonly T2Host[]) =>
      async (finding: { title: string; evidenceQuote: string; file: string }) => {
        const host = pickVerifierHost(pool, makerHost.baseUrl);
        if (!host) throw new Error('no independent host: the caller must not pass verify');
        verifiedOn.push(host.baseUrl);
        verifyPrompts.push(
          buildVerifyPrompt(
            {
              id: 0,
              severity: 3,
              dimension: 'code_health',
              file: finding.file,
              title: finding.title,
              evidenceQuote: finding.evidenceQuote,
              rationale: '',
              finderHostUrl: makerHost.baseUrl,
            },
            finding.evidenceQuote,
          ),
        );
        return { refuted: false, reason: 'cannot refute: the body only forwards' };
      };

    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway(makerCalls, JUDGMENT, makerPrompts, makerHost.modelSlot),
      workspaceId,
      repoId,
      commitSha: 'w18-10-maker-verifier',
      files: [],
      sources: SOURCES,
      trigger: 'schedule',
      verify: verifyVia(hosts),
    });
    expect(result).toMatchObject({ judgment: 1, unverified: 0, refuted: 0 });
    expect(verifiedOn).toEqual(['http://checker:1234']);
    expect(verifiedOn).not.toContain(makerHost.baseUrl);
    expect(verifyPrompts[0]).toContain('REFUTE the finding below');
    expect(makerCalls).toHaveLength(1);
    expect(makerCalls[0]?.meta.checklistVersion).toBe('anti-slop.v2');
    for (const prompt of makerPrompts) expect(prompt).not.toContain('REFUTE');

    // Only the maker's host exists: no verifier is picked, the caller passes
    // none, and the finding is stored UNVERIFIED — never self-confirmed.
    expect(pickVerifierHost([makerHost], makerHost.baseUrl)).toBeNull();
    const alone = await runAntiSlopScan({
      db,
      gateway: fakeGateway([], JUDGMENT, [], makerHost.modelSlot),
      workspaceId,
      repoId,
      commitSha: 'w18-10-maker-alone',
      files: [],
      sources: SOURCES,
      trigger: 'schedule',
    });
    expect(alone).toMatchObject({ judgment: 1, unverified: 1 });

    // Below the verify floor nothing is re-judged at all, as before v2.
    const low: string[] = [];
    await runAntiSlopScan({
      db,
      gateway: fakeGateway([], judgment({ severity: 2 })),
      workspaceId,
      repoId,
      commitSha: 'w18-10-below-floor',
      files: [],
      sources: SOURCES,
      trigger: 'schedule',
      verify: async () => {
        low.push('called');
        return { refuted: true, reason: 'x' };
      },
    });
    expect(low).toEqual([]);
  });

  it('the deterministic layer runs from SOURCES; with no candidate, the model is not called', async () => {
    const lowDensity = [
      ...Array.from({ length: 40 }, (_, i) => `// explanation line ${i}`),
      'export const one = 1;',
    ].join('\n');

    const calls: CompleteOpts[] = [];
    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway(calls),
      workspaceId,
      repoId,
      commitSha: 'w9-03-ldr',
      files,
      sources: [{ path: 'src/thin.ts', source: lowDensity }],
      trigger: 'schedule',
      verify: async () => ({ refuted: false, reason: 'ok' }),
    });

    expect(result.deterministic).toBe(1);
    // LDR is arithmetic, not a candidate: nothing for a model to judge, so no
    // call, where v1 would have sent the whole diff.
    expect(result.candidates).toBe(0);
    expect(calls).toEqual([]);
    const [row] = await db
      .select()
      .from(read.findings)
      .where(
        and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'slop.low_logic_density')),
      );
    expect(row?.file).toBe('src/thin.ts');
    // The counts are in the evidence, so the arithmetic is what gets argued
    // with rather than the number.
    expect(row?.evidence).toMatch(/logic \d+, overhead \d+/);
  });

  it('does NOT re-report a file the dependency scanner already flagged', async () => {
    // FR-CH-3 says cross-link, never duplicate: two findings for one
    // hallucinated package is two triage decisions for one problem.
    // The finding needs a parent run: the W8-04 check constraint requires
    // exactly one, which is what caught the first version of this fixture.
    const [depRun] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'dependency',
        scannerVersion: 'test',
        commitSha: 'w9-03-dep-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();

    await db.insert(read.findings).values({
      workspaceId,
      repoId,
      scanRunId: depRun!.id,
      analysisRunId: null,
      pullRequestId: null,
      dimension: 'dependency',
      severity: 4,
      confidence: 4,
      title: 'Hallucinated package',
      file: 'src/ghost.ts',
      lineStart: 1,
      lineEnd: 1,
      evidence: 'package not in registry',
      recommendation: 'remove it',
      tier: 1,
      dedupKey: 'w9-03-slopsquat',
      status: 'open',
      scannerKey: 'dependency',
      ruleId: 'slopsquat',
    });

    const thin = [
      ...Array.from({ length: 40 }, (_, i) => `// line ${i}`),
      'export const x = 1;',
    ].join('\n');
    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway([]),
      workspaceId,
      repoId,
      commitSha: 'w9-03-crosslink',
      files: [],
      sources: [{ path: 'src/ghost.ts', source: thin }],
      trigger: 'schedule',
    });
    expect(result.deterministic).toBe(0);
  });

  it('W18-01: unused exports run in SHADOW until promoted, and stop when deprecated', async () => {
    const sources = [
      { path: 'src/util.ts', source: 'export const used = 1;\nexport const dead = 2;' },
      { path: 'src/app.ts', source: "import { used } from './util.js';\nconsole.info(used);" },
    ];
    const scan = (commitSha: string) =>
      runAntiSlopScan({
        db,
        workspaceId,
        repoId,
        commitSha,
        files: [],
        sources,
        trigger: 'schedule',
      });
    const rows = () =>
      db
        .select()
        .from(read.findings)
        .where(
          and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'slop.unused_export')),
        );

    // No registry row: the shipped default is candidate, so the finding is
    // stored and visible but stamped experimental — out of every score.
    const first = await scan('w18-01-shadow');
    expect(first.status).toBe('succeeded');
    const [shadow] = await rows();
    expect(shadow).toMatchObject({
      file: 'src/util.ts',
      lineStart: 2,
      title: 'Unused export: dead',
      evidence: 'export const dead = 2;',
      experimental: true,
    });
    expect((await rows()).length).toBe(1);

    // Promoted by an admin: the SAME row starts counting on the next run.
    await db.insert(security.ruleRegistry).values({
      workspaceId,
      ruleId: 'slop.unused_export',
      status: 'active',
      provenance: { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' },
    });
    await scan('w18-01-active');
    const promoted = await rows();
    expect(promoted.length).toBe(1);
    expect(promoted[0]?.experimental).toBe(false);
    expect(promoted[0]?.occurrenceCount).toBe(2);

    // Deprecated: the rule does not run, so the run reports nothing new.
    await db
      .update(security.ruleRegistry)
      .set({ status: 'deprecated' })
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, workspaceId),
          eq(security.ruleRegistry.ruleId, 'slop.unused_export'),
        ),
      );
    const deprecated = await scan('w18-01-deprecated');
    expect(deprecated.deterministic).toBe(0);
  });

  it('W18-02: phantom imports are stored in shadow at severity 3; missing modules need a complete read', async () => {
    const sources = [
      { path: 'src/money.ts', source: 'export function format() {}' },
      {
        path: 'src/pay.ts',
        source: "import { format, toCents } from './money.js';\nimport { audit } from './audit';",
      },
    ];
    const rows = (ruleId: string) =>
      db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, ruleId)));

    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-02-partial',
      files: [],
      sources,
      trigger: 'schedule',
    });
    const [symbol] = await rows('slop.phantom_symbol');
    expect(symbol).toMatchObject({
      severity: 3,
      experimental: true,
      title: 'Import of a name that does not exist: toCents from ./money.js',
      evidence: "import { format, toCents } from './money.js'",
    });
    // sourcesComplete not stated: a missing module could be one the reader skipped.
    expect(await rows('slop.phantom_module')).toEqual([]);

    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-02-complete',
      files: [],
      sources,
      sourcesComplete: true,
      trigger: 'schedule',
    });
    const [moduleRow] = await rows('slop.phantom_module');
    expect(moduleRow).toMatchObject({ file: 'src/pay.ts', lineStart: 2, experimental: true });
  });

  it('W18-14: the Rust module graph feeds the same shadow rules', async () => {
    // The W18-01 case above leaves slop.unused_export deprecated; back to the
    // shipped default (no row = candidate) so the Rust half is observable.
    await db
      .delete(security.ruleRegistry)
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, workspaceId),
          eq(security.ruleRegistry.ruleId, 'slop.unused_export'),
        ),
      );
    const sources = [
      {
        path: 'pay/src/lib.rs',
        source: 'pub mod money;\nmod audit;\nuse crate::money::{Cents, ToDollars};\n',
      },
      {
        path: 'pay/src/money.rs',
        source: 'pub struct Cents(pub u64);\npub(crate) fn never_called() {}\n',
      },
    ];
    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-14-rust',
      files: [],
      sources,
      sourcesComplete: true,
      trigger: 'schedule',
    });
    const rows = async (ruleId: string) =>
      (
        await db
          .select()
          .from(read.findings)
          .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, ruleId)))
      ).filter((r) => r.file?.startsWith('pay/'));
    expect(await rows('slop.phantom_module')).toMatchObject([
      { file: 'pay/src/lib.rs', lineStart: 2, severity: 3, experimental: true },
    ]);
    expect(await rows('slop.phantom_symbol')).toMatchObject([
      {
        file: 'pay/src/lib.rs',
        lineStart: 3,
        title: 'Import of a name that does not exist: ToDollars from pay/src/money.rs',
        experimental: true,
      },
    ]);
    expect(await rows('slop.unused_export')).toMatchObject([
      {
        file: 'pay/src/money.rs',
        lineStart: 2,
        title: 'Unused export: never_called',
        experimental: true,
      },
    ]);
  });
  it('W18-04: suppression density is stored in shadow, per repository and per pull request', async () => {
    // 20 `as any` in 200 lines: 100/KLOC, over the ceiling with room to spare.
    const dense = Array.from({ length: 200 }, (_, i) =>
      i < 20 ? `export const v${i} = load(${i}) as any;` : `export const v${i} = load(${i});`,
    ).join('\n');
    const rows = () =>
      db
        .select()
        .from(read.findings)
        .where(
          and(
            eq(read.findings.repoId, repoId),
            eq(read.findings.ruleId, 'slop.suppression_density'),
          ),
        );

    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-04-snapshot',
      files: [],
      sources: [{ path: 'src/dense.ts', source: dense }],
      trigger: 'schedule',
    });
    const [repoRow] = await rows();
    expect(repoRow).toMatchObject({
      file: null,
      lineStart: null,
      severity: 1,
      experimental: true,
      title: 'Checker suppressions at 100 per KLOC across the repository',
    });
    expect(repoRow?.recommendation).toContain('as-any 20');

    // The density moving is the same finding, not a new one.
    const lighter = dense.replace('load(0) as any', 'load(0)');
    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-04-again',
      files: [],
      sources: [{ path: 'src/dense.ts', source: lighter }],
      trigger: 'schedule',
    });
    expect((await rows()).length).toBe(1);

    // Pull-request mode counts what the diff adds.
    const patch = [
      '@@ -1,1 +1,7 @@',
      ' const keep = 1;',
      ...Array.from({ length: 6 }, (_, i) => `+const a${i} = x as any;`),
    ].join('\n');
    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-04-pr',
      trigger: 'pr_synced',
      files: [{ path: 'src/pr.ts', patch }],
    });
    const pr = (await rows()).find((r) => r.title.startsWith('This change adds'));
    expect(pr).toMatchObject({
      title: 'This change adds 6 checker suppressions',
      experimental: true,
    });

    // Deprecated: the rule stops — no row is sighted again.
    const before = (await rows()).map((r) => [r.id, r.occurrenceCount]);
    await db.insert(security.ruleRegistry).values({
      workspaceId,
      ruleId: 'slop.suppression_density',
      status: 'deprecated',
      provenance: { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' },
    });
    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-04-deprecated',
      files: [],
      sources: [{ path: 'src/dense.ts', source: dense }],
      trigger: 'schedule',
    });
    expect((await rows()).map((r) => [r.id, r.occurrenceCount])).toEqual(before);
  });

  it('W18-11: Python phantom imports land under the same rule ids, in shadow', async () => {
    const sources = [
      { path: 'shop/__init__.py', source: '' },
      { path: 'shop/money.py', source: 'def fmt(x):\n    return x\n' },
      {
        path: 'shop/pay.py',
        source: 'from .money import fmt, to_cents\nfrom .audit import record\n',
      },
    ];
    const rows = (ruleId: string) =>
      db
        .select()
        .from(read.findings)
        .where(
          and(
            eq(read.findings.repoId, repoId),
            eq(read.findings.ruleId, ruleId),
            eq(read.findings.file, 'shop/pay.py'),
          ),
        );

    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-11-python',
      files: [],
      sources,
      sourcesComplete: true,
      trigger: 'schedule',
    });
    expect(await rows('slop.phantom_symbol')).toMatchObject([
      {
        severity: 3,
        experimental: true,
        lineStart: 1,
        title: 'Import of a name that does not exist: to_cents from .money',
        evidence: 'from .money import fmt, to_cents',
      },
    ]);
    expect(await rows('slop.phantom_module')).toMatchObject([
      { lineStart: 2, experimental: true, title: 'Import of a missing module: .audit' },
    ]);
  });

  it('W18-12: Go phantom packages and identifiers share the rule ids, in shadow; go.mod is not code', async () => {
    const sources = [
      { path: 'go.mod', source: 'module example.com/app\n\ngo 1.22\n' },
      {
        path: 'internal/money/money.go',
        source: 'package money\n\nfunc Format(c int) string { return "" }\n',
      },
      {
        path: 'pay/pay.go',
        source: [
          'package pay',
          '',
          'import (',
          '\t"example.com/app/internal/audit"',
          '\t"example.com/app/internal/money"',
          ')',
          '',
          'func Pay(c int) string {',
          '\taudit.Log(c)',
          '\treturn money.Format(money.ToCents(c))',
          '}',
        ].join('\n'),
      },
    ];
    const rows = (ruleId: string) =>
      db
        .select()
        .from(read.findings)
        .where(
          and(
            eq(read.findings.repoId, repoId),
            eq(read.findings.ruleId, ruleId),
            eq(read.findings.file, 'pay/pay.go'),
          ),
        );

    const result = await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-12-go',
      files: [],
      sources,
      sourcesComplete: true,
      trigger: 'schedule',
    });
    expect(result.status).toBe('succeeded');
    const [symbol] = await rows('slop.phantom_symbol');
    expect(symbol).toMatchObject({
      severity: 3,
      experimental: true,
      lineStart: 10,
      title: 'Reference to a name that does not exist: ToCents in example.com/app/internal/money',
    });
    const [pkg] = await rows('slop.phantom_module');
    expect(pkg).toMatchObject({ lineStart: 4, experimental: true });
    // go.mod rides along for the graph only: no per-file layer reports on it.
    const onGoMod = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.file, 'go.mod')));
    expect(onGoMod).toEqual([]);
  });

  it('W18-09: exception control flow and repository-over-CRUD run in shadow, and stop when deprecated', async () => {
    const sources = [
      {
        path: 'src/orders.py',
        source: [
          'def charge(order):',
          '    try:',
          '        if order.total <= 0:',
          '            raise ValueError("nothing to charge")',
          '        return pay(order)',
          '    except ValueError as exc:',
          '        return str(exc)',
        ].join('\n'),
      },
      {
        path: 'src/user.repository.ts',
        source: [
          'export class UserRepository {',
          '  constructor(private readonly prisma: Db) {}',
          '  findById(id: string) {',
          '    return this.prisma.user.findUnique({ where: { id } });',
          '  }',
          '  findAll() {',
          '    return this.prisma.user.findMany();',
          '  }',
          '  remove(id: string) {',
          '    return this.prisma.user.delete({ where: { id } });',
          '  }',
          '}',
        ].join('\n'),
      },
    ];
    const scan = (commitSha: string) =>
      runAntiSlopScan({
        db,
        workspaceId,
        repoId,
        commitSha,
        files: [],
        sources,
        trigger: 'schedule',
      });
    const rows = (ruleId: string) =>
      db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, ruleId)));

    expect((await scan('w18-09-shadow')).status).toBe('succeeded');
    const [flow] = await rows('slop.exception_control_flow');
    expect(flow).toMatchObject({
      file: 'src/orders.py',
      lineStart: 4,
      severity: 1,
      experimental: true,
      title: 'Exception used as control flow (caught on line 6)',
      evidence: 'raise ValueError("nothing to charge")',
    });
    const [crud] = await rows('slop.repository_over_crud');
    expect(crud).toMatchObject({
      file: 'src/user.repository.ts',
      lineStart: 1,
      severity: 1,
      experimental: true,
      title: 'Repository over CRUD: UserRepository',
    });

    // Deprecating one rule stops it without touching the other.
    await db.insert(security.ruleRegistry).values({
      workspaceId,
      ruleId: 'slop.exception_control_flow',
      status: 'deprecated',
      provenance: { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' },
    });
    const after = await scan('w18-09-deprecated');
    expect(after.deterministic).toBe(1);
  });

  it('W18-03: hollow tests land in test_coverage at severity <= 2, in shadow until promoted', async () => {
    const sources = [
      { path: 'src/cart.ts', source: 'export const total = (xs) => xs.length;' },
      {
        path: 'src/cart.test.ts',
        source: [
          "import { total } from './cart.js';",
          "it('counts', () => { total([1]); });",
          "it('is green', () => { expect(true).toBe(true); });",
        ].join('\n'),
      },
    ];
    const scan = (commitSha: string) =>
      runAntiSlopScan({
        db,
        workspaceId,
        repoId,
        commitSha,
        files: [],
        sources,
        trigger: 'schedule',
      });
    const rows = () =>
      db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'test_coverage')));

    expect((await scan('w18-03-shadow')).status).toBe('succeeded');
    const shadow = await rows();
    expect(shadow.map((r) => [r.ruleId, r.lineStart, r.severity, r.experimental]).sort()).toEqual([
      ['test.no_assertion', 2, 1, true],
      ['test.tautology', 3, 2, true],
    ]);
    expect(shadow.find((r) => r.ruleId === 'test.tautology')).toMatchObject({
      file: 'src/cart.test.ts',
      scannerKey: 'anti_slop',
      title: 'Assertion that cannot fail',
      evidence: "it('is green', () => { expect(true).toBe(true); });",
    });

    // Promoted: the same row counts from its next sighting; the others stay shadow.
    await db.insert(security.ruleRegistry).values({
      workspaceId,
      ruleId: 'test.tautology',
      status: 'active',
      provenance: { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' },
    });
    await scan('w18-03-active');
    const promoted = await rows();
    expect(promoted.length).toBe(2);
    expect(promoted.find((r) => r.ruleId === 'test.tautology')?.experimental).toBe(false);
    expect(promoted.find((r) => r.ruleId === 'test.no_assertion')?.experimental).toBe(true);

    // Deprecated: that rule stops; the run reports only the other.
    await db
      .update(security.ruleRegistry)
      .set({ status: 'deprecated' })
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, workspaceId),
          eq(security.ruleRegistry.ruleId, 'test.tautology'),
        ),
      );
    const deprecated = await scan('w18-03-deprecated');
    expect(deprecated.deterministic).toBe(1);
  });

  it('W18-05: structural slop runs in shadow; the interface count needs a complete read', async () => {
    const sources = [
      {
        path: 'src/clock.ts',
        source: [
          'export interface ClockSource {',
          '  now(): number;',
          '}',
          'export class SystemClock implements ClockSource {',
          '  now(): number {',
          '    return Date.now();',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        path: 'src/user.ts',
        source: [
          "import { fetchUser } from './api.js';",
          "import type { ClockSource } from './clock.js';",
          '/**',
          ' * @param userId the id',
          ' */',
          'export function getUser(id: string) {',
          '  return fetchUser(id);',
          '}',
          'export const at = (c: ClockSource) => c.now();',
          "getUser('1');",
        ].join('\n'),
      },
      { path: 'src/api.ts', source: 'export function fetchUser(id: string) { return id; }' },
    ];
    const rows = (ruleId: string) =>
      db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, ruleId)));
    const scan = (commitSha: string, sourcesComplete: boolean) =>
      runAntiSlopScan({
        db,
        workspaceId,
        repoId,
        commitSha,
        files: [],
        sources,
        sourcesComplete,
        trigger: 'schedule',
      });

    await scan('w18-05-partial', false);
    const [wrapper] = await rows('slop.delegation_wrapper');
    expect(wrapper).toMatchObject({
      file: 'src/user.ts',
      lineStart: 6,
      severity: 1,
      title: 'Delegation-only wrapper: getUser',
      evidence: 'export function getUser(id: string) {',
      experimental: true,
    });
    const [doc] = await rows('slop.stale_jsdoc_param');
    expect(doc).toMatchObject({
      lineStart: 4,
      severity: 2,
      evidence: '@param userId the id',
      experimental: true,
    });
    // Partial read: the second implementation could be in a skipped file.
    expect(await rows('slop.single_impl_interface')).toEqual([]);

    await scan('w18-05-complete', true);
    const [single] = await rows('slop.single_impl_interface');
    expect(single).toMatchObject({
      file: 'src/clock.ts',
      lineStart: 1,
      title: 'Single-implementation interface: ClockSource',
      experimental: true,
    });

    // Deprecated in this workspace: the rule stops; the others carry on.
    await db.insert(security.ruleRegistry).values({
      workspaceId,
      ruleId: 'slop.stale_jsdoc_param',
      status: 'deprecated',
      provenance: { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' },
    });
    const before = (await rows('slop.stale_jsdoc_param'))[0]?.occurrenceCount;
    await scan('w18-05-deprecated', true);
    expect((await rows('slop.stale_jsdoc_param'))[0]?.occurrenceCount).toBe(before);
    expect((await rows('slop.delegation_wrapper'))[0]?.occurrenceCount).toBe(3);
  });

  it('W18-07: leftover-content rules land in shadow, and a deprecated rule stops', async () => {
    const sources = [
      {
        path: 'src/pay.ts',
        source: [
          "export const apiKey = 'YOUR_API_KEY';",
          '// const old = charge(card);',
          '// if (old.ok) {',
          '//   receipt(old);',
          '// }',
          "export const raw = new Buffer('x');",
        ].join('\n'),
      },
      { path: 'app/clock.py', source: 'import datetime\nnow = datetime.datetime.utcnow()\n' },
    ];
    const scan = (commitSha: string) =>
      runAntiSlopScan({
        db,
        workspaceId,
        repoId,
        commitSha,
        files: [],
        sources,
        trigger: 'schedule',
      });
    const rows = (ruleId: string) =>
      db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, ruleId)));

    expect((await scan('w18-07-shadow')).status).toBe('succeeded');
    expect(await rows('slop.placeholder_value')).toEqual([
      expect.objectContaining({
        file: 'src/pay.ts',
        lineStart: 1,
        severity: 2,
        evidence: "'YOUR_API_KEY'",
        experimental: true,
      }),
    ]);
    expect(await rows('slop.commented_out_code')).toEqual([
      expect.objectContaining({ file: 'src/pay.ts', lineStart: 2, lineEnd: 5, experimental: true }),
    ]);
    const deprecated = await rows('slop.deprecated_api');
    expect(deprecated.map((r) => [r.file, r.lineStart, r.title, r.experimental]).sort()).toEqual([
      ['app/clock.py', 2, 'Deprecated API: python.datetime_utcnow', true],
      ['src/pay.ts', 6, 'Deprecated API: node.buffer_constructor', true],
    ]);

    // Deprecating one rule stops it without touching the other two.
    await db.insert(security.ruleRegistry).values({
      workspaceId,
      ruleId: 'slop.commented_out_code',
      status: 'deprecated',
      provenance: { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' },
    });
    try {
      const before = (await rows('slop.commented_out_code'))[0]?.occurrenceCount;
      await scan('w18-07-deprecated');
      expect((await rows('slop.commented_out_code'))[0]?.occurrenceCount).toBe(before);
      expect((await rows('slop.placeholder_value'))[0]?.occurrenceCount).toBe(2);
    } finally {
      await db
        .delete(security.ruleRegistry)
        .where(
          and(
            eq(security.ruleRegistry.workspaceId, workspaceId),
            eq(security.ruleRegistry.ruleId, 'slop.commented_out_code'),
          ),
        );
    }
  });

  it('W18-08: async smells and speculative generality run in shadow, and stop when deprecated', async () => {
    const sources = [
      {
        path: 'src/net.ts',
        source: [
          'export async function connect(url) {',
          '  while (true) {',
          '    try {',
          '      return await open(url);',
          '    } catch (err) {',
          '      console.warn(err);',
          '    }',
          '  }',
          '}',
          'export async function page(api, id) {',
          '  const user = await api.getUser(id);',
          '  const prefs = await api.getPrefs(id);',
          '  return { user, prefs };',
          '}',
          'function send(report, retries = 3) { return post(report, retries); }',
          'const ENABLE_NEW_CHECKOUT = true;',
          'export function go(r) { send(r); return ENABLE_NEW_CHECKOUT; }',
        ].join('\n'),
      },
    ];
    const scan = (commitSha: string) =>
      runAntiSlopScan({
        db,
        workspaceId,
        repoId,
        commitSha,
        files: [],
        sources,
        trigger: 'schedule',
      });
    const rows = (ruleId: string) =>
      db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, ruleId)));

    const first = await scan('w18-08-shadow');
    expect(first.status).toBe('succeeded');
    const [retry] = await rows('slop.unbounded_retry');
    expect(retry).toMatchObject({
      dimension: 'slop',
      severity: 2,
      lineStart: 2,
      experimental: true,
      title: 'Retry with no attempt limit or backoff',
    });
    const [serial] = await rows('perf.serial_independent_awaits');
    expect(serial).toMatchObject({ dimension: 'performance', lineStart: 11, experimental: true });
    const [param] = await rows('slop.speculative_param');
    expect(param).toMatchObject({
      lineStart: 15,
      title: 'Default no caller overrides: send(retries)',
    });
    const [flag] = await rows('slop.orphan_flag');
    expect(flag).toMatchObject({ lineStart: 16, experimental: true });

    // Deprecated: that one rule stops; the others keep running.
    await db.insert(security.ruleRegistry).values({
      workspaceId,
      ruleId: 'slop.unbounded_retry',
      status: 'deprecated',
      provenance: { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' },
    });
    const later = await scan('w18-08-deprecated');
    expect(later.deterministic).toBe(first.deterministic - 1);
  });

  it('W18-06: dependency hygiene runs in shadow from the snapshot, stays silent without one, and stops when deprecated', async () => {
    const triggering = path.join(DEP_FIXTURES, 'triggering');
    const sources = readSnapshotSources(triggering).files;
    const rows = (ruleId: string) =>
      db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, ruleId)));

    // No snapshotDir: the stored SBOM is not consulted, nothing is guessed.
    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-06-none',
      files: [],
      sources,
      trigger: 'schedule',
    });
    expect(await rows('slop.duplicate_purpose_deps')).toEqual([]);
    expect(await rows('slop.library_reimplementation')).toEqual([]);

    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-06-shadow',
      files: [],
      sources,
      snapshotDir: triggering,
      trigger: 'schedule',
    });
    const duplicates = await rows('slop.duplicate_purpose_deps');
    expect(duplicates.length).toBe(12);
    expect(duplicates.every((r) => r.experimental && r.severity === 1)).toBe(true);
    // Anchored on the manifest a person edits, at the later library's line.
    const dates = duplicates.find((r) => r.title.includes('(dates): moment, dayjs'));
    expect(dates).toMatchObject({ file: 'web/package.json', lineStart: 6 });
    const reimpl = await rows('slop.library_reimplementation');
    expect(reimpl.map((r) => `${r.file}:${r.lineStart}`).sort()).toEqual(
      [
        'api/app/text.py:6',
        'api/app/text.py:13',
        'jvm/src/main/java/com/acme/Text.java:6',
        'svc/text.go:12',
        'svc/text.go:16',
        'web/src/util.ts:11',
        'web/src/util.ts:20',
        'web/src/util.ts:3',
      ].sort(),
    );
    expect(reimpl.every((r) => r.experimental)).toBe(true);

    for (const ruleId of ['slop.duplicate_purpose_deps', 'slop.library_reimplementation']) {
      await db.insert(security.ruleRegistry).values({
        workspaceId,
        ruleId,
        status: 'deprecated',
        provenance: { source: 'ours', license: 'UNLICENSED', author: 'test', date: '2026-10-15' },
      });
    }
    const stopped = await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-06-deprecated',
      files: [],
      sources: [],
      snapshotDir: triggering,
      trigger: 'schedule',
    });
    expect(stopped.deterministic).toBe(0);
  });

  it('writes the import graph for the exposure reprice (W18-25)', async () => {
    const sources = [
      { path: 'src/user.js', source: 'export function fetchUser(id) { return id; }\n' },
      { path: 'src/routes/profile.js', source: "import { fetchUser } from '../user.js';\n" },
      { path: 'src/admin.js', source: "import { fetchUser } from './user.js';\n" },
    ];
    const gateway: AnalysisGateway = {
      async complete() {
        return {
          text: '{"findings":[]}',
          model: 'fake-finder',
          tokensIn: 1,
          tokensOut: 1,
          costUsd: null,
          durationMs: 1,
        };
      },
      async health() {
        return { ok: true };
      },
    };

    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-25-sha',
      files,
      sources,
      sourcesComplete: true,
      trigger: 'manual',
      gateway,
    });

    const graph = await readImportGraph(db, workspaceId, repoId);
    expect(graph).toMatchObject({ commitSha: 'w18-25-sha', complete: true });
    expect(graph?.files).toEqual(['src/admin.js', 'src/routes/profile.js', 'src/user.js']);
    expect(graph?.edges).toHaveLength(2);

    // A capped snapshot is recorded as such, for the pricer to go neutral on.
    await runAntiSlopScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-25-capped',
      files: [],
      sources,
      trigger: 'schedule',
    });
    expect(await readImportGraph(db, workspaceId, repoId)).toMatchObject({
      commitSha: 'w18-25-capped',
      complete: false,
    });
  });
});

describe('layer separation and sampling', () => {
  it('ranks the worst-LDR files first, for the weekly sample', () => {
    const dense = ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n');
    const thin = ['// one', '// two', '// three', 'const a = 1;'].join('\n');
    expect(
      worstByLdr(
        [
          { path: 'dense.ts', source: dense },
          { path: 'thin.ts', source: thin },
        ],
        1,
      ),
    ).toEqual(['thin.ts']);
  });

  it('a deterministic finding and a T2 finding on the same evidence share a key', () => {
    // FR-CH-5 dedupe alignment: the pack rule and the checklist can see the
    // same line, and two rows for one problem is what makes people stop
    // reading the list.
    const shared = {
      dimension: 'code_health',
      file: 'src/user.js',
      evidenceQuote: '  return inner.fetchUser(id);',
      lineStart: 2,
    };
    expect(dedupKey({ ...shared, scannerKey: 'anti_slop', ruleId: 'slop.judgment' })).toBe(
      dedupKey({ ...shared, scannerKey: 'anti_slop', ruleId: 'slop.judgment' }),
    );
    // And a DIFFERENT scanner reporting the same line stays separate, because
    // those are two tools' opinions rather than one duplicated row.
    expect(dedupKey({ ...shared, scannerKey: 'anti_slop', ruleId: 'slop.judgment' })).not.toBe(
      dedupKey({ ...shared, scannerKey: 'semgrep', ruleId: 'bpm-ch-empty-catch' }),
    );
  });
});
