import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import type { AnalysisGateway, CompleteOpts } from '@repopulse/analysis';
import { runOwaspChecklist } from './run.js';
import { owaspLlmApplies } from './llm-packages.js';

// OWASP checklist scanners, end to end (W8-08, FR-SEC-7).
//
// The gateway is a FAKE here on purpose. What needs proving is the path — the
// prompt is built, the response is validated against the diff it reviewed, the
// findings reach the store with their chaining vocabulary, and the accounting
// meta says which scanner spent the tokens. A live model would make every one
// of those assertions flaky while proving nothing extra: LM Studio's answer is
// not part of this contract.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const FP = 'w8-08-fp';
const SHA = 'w8-08-commit-sha-00000000000000000000';

const PATCH = [
  '@@ -1,4 +1,8 @@',
  ' const express = require("express");',
  '+app.get("/u/:id", async (req, res) => {',
  '+  const row = await db.query("select * from users where id = " + req.params.id);',
  '+  res.json(row);',
  '+});',
].join('\n');

/** Records what the scanner asked for, and answers with a fixed finding. */
function fakeGateway(calls: CompleteOpts[], response?: string): AnalysisGateway {
  return {
    async complete(prompt: string, opts: CompleteOpts) {
      calls.push(opts);
      void prompt;
      return {
        text:
          response ??
          JSON.stringify({
            findings: [
              {
                dimension: 'security',
                severity: 4,
                confidence: 4,
                file: 'src/routes.js',
                line_range: [3, 3],
                title: 'A03: user id interpolated into SQL',
                // VERBATIM from the patch — the validator checks this, and a
                // paraphrase here would be dropped exactly as a model's would.
                evidence_quote:
                  'const row = await db.query("select * from users where id = " + req.params.id);',
                rationale: 'The id is concatenated into the query rather than parameterised.',
                suggested_fix: 'Use a parameterised query.',
                preconditions: ['network-access'],
                yields: ['sql-injection', 'data-read'],
              },
            ],
          }),
        model: 'fake-model-1',
        tokensIn: 100,
        tokensOut: 50,
        costUsd: null,
        durationMs: 5,
      };
    },
    async health() {
      return { ok: true };
    },
  };
}

describeIfLiveInfra('owasp checklist runs (W8-08)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;

  const files = [{ path: 'src/routes.js', patch: PATCH, status: 'modified' as const }];

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w8-08-user', forgeUserId: 'w8-08-user', login: 'w8-08-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-08-user' } })
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
        forgeRepoId: 'w8-08-repo',
        org: 'acme',
        name: 'owasp',
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
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(security.sboms).where(eq(security.sboms.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('runs owasp_web through the gateway and stores the finding with its yields', async () => {
    const calls: CompleteOpts[] = [];
    const result = await runOwaspChecklist({
      db,
      gateway: fakeGateway(calls),
      key: 'owasp_web',
      workspaceId,
      repoId,
      files,
      commitSha: SHA,
      trigger: 'manual',
    });

    expect(result.status).toBe('succeeded');
    expect(result.findingsCreated).toBe(1);
    expect(result.rejected).toBe(0);

    // Every call is Tier-2 at the enforced cap, tagged with the SCANNER that
    // spent it — scanner spend has to be separable from review spend, or the
    // first question about an LLM bill has no answer.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tier).toBe('T2');
    expect(calls[0]?.maxTokens).toBe(45_000);
    expect(calls[0]?.meta.initiator).toBe('scanner:owasp_web');
    expect(calls[0]?.meta.checklistVersion).toBe('owasp-web.v1');

    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.scannerKey, 'owasp_web')));
    expect(row?.severity).toBe(4);
    expect(row?.tier).toBe(2);
    // The chaining vocabulary survived the trip into the store (§3.5).
    expect(row?.yields).toEqual({ 'sql-injection': true, 'data-read': true });

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.scannerKey, 'owasp_web'));
    expect(run?.status).toBe('succeeded');
    expect(run?.scannerVersion).toBe('owasp-web.v1');
    expect(run?.toolVersions?.['models']).toBe('fake-model-1');
  });

  it('a security finding at severity >= 3 MEETS the Tier-3 trigger but needs opt-in', async () => {
    // Decided, never assumed: without the per-repo opt-in the escalation is
    // refused rather than downgraded, and nothing leaves the network.
    const withoutOptIn = await runOwaspChecklist({
      db,
      gateway: fakeGateway([]),
      key: 'owasp_web',
      workspaceId,
      repoId,
      files,
      commitSha: 'w8-08-sha-2',
    });
    expect(withoutOptIn.escalations.met).toBe(1);
    expect(withoutOptIn.escalations.permitted).toBe(0);

    const withOptIn = await runOwaspChecklist({
      db,
      gateway: fakeGateway([]),
      key: 'owasp_web',
      workspaceId,
      repoId,
      files,
      commitSha: 'w8-08-sha-3',
      t3OptIn: true,
    });
    expect(withOptIn.escalations.permitted).toBe(1);
  });

  it('DROPS a finding whose quote is not in the diff, and counts it', async () => {
    // The load-bearing validator: a plausible paraphrase is a finding about
    // code that does not exist.
    const invented = JSON.stringify({
      findings: [
        {
          dimension: 'security',
          severity: 5,
          confidence: 5,
          file: 'src/routes.js',
          line_range: [3, 3],
          title: 'A03: invented',
          evidence_quote: 'const row = db.execute(userSuppliedString) // never in the diff',
          rationale: 'x',
          suggested_fix: null,
          preconditions: [],
          yields: ['rce'],
        },
      ],
    });
    const result = await runOwaspChecklist({
      db,
      gateway: fakeGateway([], invented),
      key: 'owasp_web',
      workspaceId,
      repoId,
      files,
      commitSha: 'w8-08-sha-4',
    });
    expect(result.findingsTotal).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.status).toBe('succeeded');
  });

  it('a chunk whose output is unparseable contributes nothing and is counted', async () => {
    const result = await runOwaspChecklist({
      db,
      gateway: fakeGateway([], 'the model said hello instead of JSON'),
      key: 'owasp_web',
      workspaceId,
      repoId,
      files,
      commitSha: 'w8-08-sha-5',
    });
    expect(result.findingsTotal).toBe(0);
    expect(result.rejected).toBe(1);
  });

  it('owasp_llm does NOT run when there is no SBOM, and says why', async () => {
    // no_sbom is a fact about US; no_llm_packages is a fact about the repo.
    // Collapsing them would render "nobody has looked" as "not applicable".
    expect(await owaspLlmApplies(db, workspaceId, repoId)).toEqual({
      applies: false,
      reason: 'no_sbom',
    });

    const result = await runOwaspChecklist({
      db,
      gateway: fakeGateway([]),
      key: 'owasp_llm',
      workspaceId,
      repoId,
      files,
      commitSha: 'w8-08-sha-6',
    });
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toBe('no_sbom');
    // AND no scan_run row: a scanner that did not run must not appear to have.
    expect(result.scanRunId).toBeNull();
  });

  it('owasp_llm stays off for a repo whose SBOM has no LLM package', async () => {
    await db.insert(security.sboms).values({
      workspaceId,
      repoId,
      commitSha: 'w8-08-sbom-plain',
      document: { components: [{ name: 'express' }, { name: 'lodash' }] },
      componentCount: 2,
      generatedBy: 'test',
    });

    expect(await owaspLlmApplies(db, workspaceId, repoId)).toEqual({
      applies: false,
      reason: 'no_llm_packages',
    });
    const result = await runOwaspChecklist({
      db,
      gateway: fakeGateway([]),
      key: 'owasp_llm',
      workspaceId,
      repoId,
      files,
      commitSha: 'w8-08-sha-7',
    });
    expect(result.skippedReason).toBe('no_llm_packages');
  });

  it('owasp_llm auto-enables once the SBOM shows an LLM client', async () => {
    await db.insert(security.sboms).values({
      workspaceId,
      repoId,
      commitSha: 'w8-08-sbom-llm',
      document: { components: [{ name: 'express' }, { name: '@anthropic-ai/sdk' }] },
      componentCount: 2,
      generatedBy: 'test',
    });

    const applicability = await owaspLlmApplies(db, workspaceId, repoId);
    expect(applicability.applies).toBe(true);

    const calls: CompleteOpts[] = [];
    const result = await runOwaspChecklist({
      db,
      gateway: fakeGateway(calls),
      key: 'owasp_llm',
      workspaceId,
      repoId,
      files,
      commitSha: 'w8-08-sha-8',
    });
    expect(result.status).toBe('succeeded');
    expect(calls[0]?.meta.initiator).toBe('scanner:owasp_llm');
    expect(calls[0]?.meta.checklistVersion).toBe('owasp-llm.v1');
  });
});
