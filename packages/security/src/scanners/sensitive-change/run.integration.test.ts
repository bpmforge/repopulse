import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, facts, read, security, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { runSecretsStreamScan, scanOneTarget } from '../secrets/stream.js';
import { SECRETS_SCANNER_KEY } from '../secrets/scanner.js';
import {
  HUMAN_REVIEW_PREFIX,
  runSensitiveChangeScan,
  SENSITIVE_CHANGE_SCANNER_KEY,
  SENSITIVE_CHANGE_VERSION,
} from './run.js';

// The sensitive-change radar against a live database (W18-21).
//
// What needs proving beyond the fixtures: that the radar actually RUNS on the
// path a PR takes (the secrets stream), stores a finding that asks for a human,
// stays in shadow until promoted, stops when deprecated, and never runs over
// history, where every year-old change would ask for a review nobody can give.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const HEAD_SHA = 'w18-21-head-sha-000000000000000000000';
const FP = 'w18-21-radar-fp';
const RULE = 'sensitive.authz_check_removed';

const PATCH = [
  '@@ -10,7 +10,7 @@ const router = Router();',
  " router.get('/users', listUsers);",
  "-router.delete('/users/:id', requireAdmin, deleteUser);",
  "+router.delete('/users/:id', deleteUser);",
].join('\n');

const FILES = [{ path: 'src/routes/users.ts', patch: PATCH, status: 'modified' as const }];

function fakeProvider(): ForgeProvider {
  const page = async () => ({
    items: [{ path: 'src/routes/users.ts', patch: PATCH, status: 'modified' }],
  });
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getPullRequestFiles: page,
    getCommitFiles: page,
  } as unknown as ForgeProvider;
}

describeIfLiveInfra('sensitive-change radar (W18-21)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let identityId = 0;
  let pullRequestId = 0;

  const radarRows = () =>
    db
      .select()
      .from(read.findings)
      .where(
        and(
          eq(read.findings.repoId, repoId),
          eq(read.findings.scannerKey, SENSITIVE_CHANGE_SCANNER_KEY),
        ),
      );
  const radarRuns = () =>
    db
      .select()
      .from(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.repoId, repoId),
          eq(security.scanRuns.scannerKey, SENSITIVE_CHANGE_SCANNER_KEY),
        ),
      );
  const setRule = async (status: 'active' | 'deprecated') => {
    await db
      .delete(security.ruleRegistry)
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, workspaceId),
          eq(security.ruleRegistry.ruleId, RULE),
        ),
      );
    await db.insert(security.ruleRegistry).values({
      workspaceId,
      ruleId: RULE,
      status,
      provenance: {
        source: 'w18-21-test',
        license: 'proprietary',
        author: 'RepoPulse',
        date: '2026-10-15',
      },
    });
  };

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
        authSubject: 'w18-21-user',
        forgeUserId: 'w18-21-user',
        login: 'w18-21-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w18-21-user' } })
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
        forgeRepoId: 'w18-21-repo',
        org: 'acme',
        name: 'radar',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    const [identity] = await db
      .insert(core.identities)
      .values({
        workspaceId,
        provider: 'github',
        forgeLogin: 'w18-21-author',
        displayName: 'W18-21 Author',
      })
      .returning();
    identityId = identity!.id;

    const [pr] = await db
      .insert(facts.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 1821,
        forgePrId: 'w18-21-pr',
        title: 'Simplify user routes',
        authorIdentityId: identityId,
        state: 'open',
        isDraft: false,
        isBot: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        baseRef: 'main',
        headSha: HEAD_SHA,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
      })
      .returning();
    pullRequestId = pr!.id;
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db
      .delete(security.ruleRegistry)
      .where(
        and(
          eq(security.ruleRegistry.workspaceId, workspaceId),
          eq(security.ruleRegistry.ruleId, RULE),
        ),
      );
    await db
      .delete(security.repoScannerConfig)
      .where(eq(security.repoScannerConfig.repoId, repoId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.repoId, repoId));
    await db.delete(core.identities).where(eq(core.identities.id, identityId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('runs on the PR path: the secrets stream diff becomes a radar finding', async () => {
    const result = await runSecretsStreamScan({
      db,
      provider: fakeProvider(),
      workspaceId,
      repoId,
      repo: 'acme/radar',
      trigger: 'pr_synced',
    });
    expect(result.scanned.map((t) => t.commitSha)).toEqual([HEAD_SHA]);

    const rows = await radarRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      dimension: 'security',
      ruleId: RULE,
      file: 'src/routes/users.ts',
      lineStart: 11,
      pullRequestId,
      // Shadow: no registry row means candidate.
      experimental: true,
      status: 'open',
      // Deterministic: nothing verified it and nothing can contradict it.
      verifyStatus: 'unverified',
      tier: 1,
    });
    expect(row!.title.startsWith(`${HUMAN_REVIEW_PREFIX}: `)).toBe(true);
    expect(row!.evidence).toContain("- router.delete('/users/:id', requireAdmin, deleteUser);");

    const runs = await radarRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'succeeded',
      trigger: 'pr_synced',
      scannerVersion: SENSITIVE_CHANGE_VERSION,
      commitSha: HEAD_SHA,
    });

    // The secrets run beside it is untouched by the radar riding along.
    const [secretsRun] = await db
      .select()
      .from(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.repoId, repoId),
          eq(security.scanRuns.scannerKey, SECRETS_SCANNER_KEY),
        ),
      );
    expect(secretsRun?.status).toBe('succeeded');
  });

  it('a second sighting of the same change creates nothing', async () => {
    const again = await runSensitiveChangeScan({
      db,
      workspaceId,
      repoId,
      commitSha: HEAD_SHA,
      trigger: 'pr_synced',
      pullRequestId,
      files: FILES,
    });
    expect(again).toMatchObject({ status: 'succeeded', signals: 1, findingsCreated: 0 });
    expect(await radarRows()).toHaveLength(1);
  });

  it('leaves shadow once an admin promotes the rule', async () => {
    await setRule('active');
    await runSensitiveChangeScan({
      db,
      workspaceId,
      repoId,
      commitSha: HEAD_SHA,
      trigger: 'pr_synced',
      pullRequestId,
      files: FILES,
    });
    const [row] = await radarRows();
    expect(row?.experimental).toBe(false);
  });

  it('a deprecated rule stops running', async () => {
    await setRule('deprecated');
    const result = await runSensitiveChangeScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-21-other-sha',
      trigger: 'push',
      files: FILES,
    });
    expect(result).toMatchObject({ status: 'succeeded', signals: 0 });
    expect(result.deprecatedRules).toEqual([RULE]);
  });

  it('never runs over history', async () => {
    const before = (await radarRuns()).length;
    await scanOneTarget(
      { db, provider: fakeProvider(), repo: 'acme/radar', repoId, workspaceId },
      { commitSha: 'w18-21-history-sha' },
      'schedule',
    );
    expect(await radarRuns()).toHaveLength(before);
  });

  it('respects an explicit opt-out for the repo', async () => {
    await db.insert(security.repoScannerConfig).values({
      workspaceId,
      repoId,
      scannerKey: SENSITIVE_CHANGE_SCANNER_KEY,
      enabled: false,
      updatedBy: userId,
    });
    const before = (await radarRuns()).length;
    const result = await runSensitiveChangeScan({
      db,
      workspaceId,
      repoId,
      commitSha: 'w18-21-opted-out',
      trigger: 'push',
      files: FILES,
    });
    expect(result.status).toBe('disabled');
    expect(await radarRuns()).toHaveLength(before);
  });
});
