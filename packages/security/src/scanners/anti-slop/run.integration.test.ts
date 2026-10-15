import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { AnalysisGateway, CompleteOpts } from '@repopulse/analysis';
import { dedupKey } from '@repopulse/insights';
import { runAntiSlopScan, worstByLdr } from './run.js';

// anti_slop (W9-03, CODE_HEALTH_SUITE.md §1/§4, FR-CH-3).
//
// The gateway is faked: what needs proving is the VERIFY GATE and the layer
// split, not what a local model happens to say about a wrapper.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const FP = 'w9-03-fp';

const PATCH = [
  '@@ -1,3 +1,7 @@',
  ' const inner = require("./inner");',
  '+function fetchUser(id) {',
  '+  return inner.fetchUser(id);',
  '+}',
  '+module.exports = { fetchUser };',
].join('\n');

const JUDGMENT = JSON.stringify({
  findings: [
    {
      dimension: 'code_health',
      severity: 4,
      confidence: 4,
      file: 'src/user.js',
      line_range: [2, 4],
      title: 'Delegation-only wrapper: fetchUser',
      evidence_quote: '  return inner.fetchUser(id);',
      rationale: 'The wrapper forwards its argument unchanged and returns the result.',
      suggested_fix: 'Call inner.fetchUser directly.',
      preconditions: [],
      yields: [],
    },
  ],
});

function fakeGateway(calls: CompleteOpts[], text = JUDGMENT): AnalysisGateway {
  return {
    async complete(_prompt: string, opts: CompleteOpts) {
      calls.push(opts);
      return {
        text,
        model: 'fake-finder',
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

  const files = [{ path: 'src/user.js', patch: PATCH, status: 'modified' as const }];

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w9-03-user', forgeUserId: 'w9-03-user', login: 'w9-03-user' })
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
          eq(security.ruleRegistry.ruleId, 'slop.unused_export'),
        ),
      );
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('a verifier-REFUTED judgement finding never appears', async () => {
    // The gate that matters. A structural claim is an accusation about
    // someone's code, and the product has to be able to be talked out of one.
    const calls: CompleteOpts[] = [];
    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway(calls),
      workspaceId,
      repoId,
      commitSha: 'w9-03-refuted',
      files,
      trigger: 'pr_synced',
      verify: async () => ({ refuted: true, reason: 'the wrapper adds a retry' }),
    });

    expect(result.status).toBe('succeeded');
    expect(result.refuted).toBe(1);
    expect(result.judgment).toBe(0);
    const rows = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'slop.judgment')));
    expect(rows).toEqual([]);
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
      trigger: 'pr_synced',
      verify: async () => ({ refuted: false, reason: 'confirmed: forwards unchanged' }),
    });

    expect(result.judgment).toBe(1);
    expect(result.refuted).toBe(0);
    // Accounting says which scanner spent the tokens.
    expect(calls[0]?.meta.initiator).toBe('scanner:anti_slop');
    expect(calls[0]?.meta.checklistVersion).toBe('anti-slop.v1');

    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'slop.judgment')));
    // The model said 4; structural slop is not exploitable, so it is capped.
    expect(row?.severity).toBe(3);
    expect(row?.tier).toBe(2);
    expect(row?.yields).toBeNull();
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
      trigger: 'pr_synced',
    });
    expect(result.unverified).toBe(1);
    expect(result.judgment).toBe(1);
  });

  it('the deterministic layer runs from SOURCES and the judgement from the DIFF', async () => {
    const lowDensity = [
      ...Array.from({ length: 40 }, (_, i) => `// explanation line ${i}`),
      'export const one = 1;',
    ].join('\n');

    const result = await runAntiSlopScan({
      db,
      gateway: fakeGateway([]),
      workspaceId,
      repoId,
      commitSha: 'w9-03-ldr',
      files,
      sources: [{ path: 'src/thin.ts', source: lowDensity }],
      trigger: 'schedule',
      verify: async () => ({ refuted: false, reason: 'ok' }),
    });

    expect(result.deterministic).toBe(1);
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
        .where(and(eq(read.findings.repoId, repoId), eq(read.findings.ruleId, 'slop.unused_export')));

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
      db, workspaceId, repoId, commitSha: 'w18-02-partial', files: [], sources, trigger: 'schedule',
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
      db, workspaceId, repoId, commitSha: 'w18-02-complete', files: [], sources,
      sourcesComplete: true, trigger: 'schedule',
    });
    const [moduleRow] = await rows('slop.phantom_module');
    expect(moduleRow).toMatchObject({ file: 'src/pay.ts', lineStart: 2, experimental: true });
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
