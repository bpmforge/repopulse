import 'dotenv/config';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, facts, read, security, type Database } from '@repopulse/shared';
import type { CallCtx, ForgeProvider } from '@repopulse/forge';
import { runSecretsStreamScan } from './stream.js';
import { SECRETS_SCANNER_KEY } from './scanner.js';

// Secrets stream mode against a live database (W8-04, FR-SEC-3 / SC-29).
//
// A unit test proves the detector; this proves the SCANNER: a planted secret in
// an ingested diff becomes a stored finding, the plaintext appears in no column
// of the findings table, and a second delta over the same head SHA creates
// nothing. The last part matters as much as the first - a scanner that
// re-reports on every webhook is one people mute.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const PLANTED = 'AKIAW8O4PLANTEDKEY77'; // AKIA + exactly 16, the real shape
const HEAD_SHA = 'w8-04-head-sha-0000000000000000000000';
const FP = 'w8-04-secrets-fp';

const PATCH = [
  '@@ -1,3 +1,5 @@',
  ' const region = "us-east-1";',
  `+const accessKeyId = "${PLANTED}";`,
  '+export const client = new S3({ accessKeyId });',
].join('\n');

/** A forge that answers with one file whose patch carries the planted key. */
function fakeProvider(calls: CallCtx[]): ForgeProvider {
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getPullRequestFiles: async (ctx: CallCtx) => {
      calls.push(ctx);
      return { items: [{ path: 'src/s3.ts', patch: PATCH, status: 'modified' }] };
    },
  } as unknown as ForgeProvider;
}

describeIfLiveInfra('secrets stream mode (W8-04)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let identityId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w8-04-user', login: 'w8-04-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-04-user' } })
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
        forgeRepoId: 'w8-04-repo',
        org: 'acme',
        name: 'secrets-stream',
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
        forgeLogin: 'w8-04-author',
        displayName: 'W8-04 Author',
      })
      .returning();
    identityId = identity!.id;

    await db.insert(facts.pullRequests).values({
      workspaceId,
      repoId,
      number: 4201,
      forgePrId: 'w8-04-pr',
      title: 'Add S3 client',
      authorIdentityId: identityId,
      state: 'open',
      isDraft: false,
      isBot: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      baseRef: 'main',
      headSha: HEAD_SHA,
      additions: 2,
      deletions: 0,
      changedFiles: 1,
    });
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
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

  it('turns a planted secret in an ingested diff into a stored finding', async () => {
    const calls: CallCtx[] = [];
    const result = await runSecretsStreamScan({
      db,
      provider: fakeProvider(calls),
      workspaceId,
      repoId,
      repo: 'acme/secrets-stream',
      trigger: 'pr_synced',
    });

    // The finding must EXIST — a redaction assertion that passes because the
    // detector found nothing proves nothing at all.
    expect(result.findingsCreated).toBe(1);
    expect(result.scanned.map((t) => t.commitSha)).toEqual([HEAD_SHA]);
    // On the scan lane, not the lane a user waiting on a page is spending.
    expect(calls.map((c) => c.lane)).toEqual(['scan']);

    const [row] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'secrets')));

    expect(row?.scannerKey).toBe(SECRETS_SCANNER_KEY);
    expect(row?.ruleId).toBe('aws-access-key-id');
    expect(row?.file).toBe('src/s3.ts');
    // Line 2 of the new file: the added line sits under one context line.
    expect(row?.lineStart).toBe(2);
    // The parent is a SCAN run, not a dummy analysis run — W8-02 had to invent
    // a tier-2 analysis_runs row to satisfy a NOT NULL, which made every
    // scanner finding claim an LLM tier it never used.
    expect(row?.scanRunId).not.toBeNull();
    expect(row?.analysisRunId).toBeNull();
    expect(row?.yields).toEqual({ 'credential:aws': true });

    const [run] = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.repoId, repoId));
    expect(run?.status).toBe('succeeded');
    expect(run?.trigger).toBe('pr_synced');
    // The RULEPACK version, because the pack is what decided this was a secret.
    expect(run?.scannerVersion).toBe('secrets.v1');
  });

  it('stores the plaintext NOWHERE, the way a database dump would show', async () => {
    // Guard against the vacuous pass: if the scan above had found nothing,
    // every grep below would come back zero and this would "prove" redaction
    // by proving there was nothing to redact.
    const [present] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(read.findings)
      .where(and(eq(read.findings.repoId, repoId), eq(read.findings.dimension, 'secrets')));
    expect(present?.n).toBe(1);

    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from findings
      where evidence like ${'%' + PLANTED + '%'}
         or title like ${'%' + PLANTED + '%'}
         or coalesce(recommendation, '') like ${'%' + PLANTED + '%'}
         or coalesce(file, '') like ${'%' + PLANTED + '%'}
         or coalesce(yields::text, '') like ${'%' + PLANTED + '%'}
    `);
    expect(rows[0]?.n, 'the planted credential must appear in no column').toBe(0);
  });

  it('a replayed delta scans nothing and creates nothing', async () => {
    // Idempotence, which stream mode gets from the warehouse rather than from
    // the webhook: the head SHA already has a succeeded run, so there is no
    // target. A scanner that re-reports on every delivery is one people mute.
    const calls: CallCtx[] = [];
    const again = await runSecretsStreamScan({
      db,
      provider: fakeProvider(calls),
      workspaceId,
      repoId,
      repo: 'acme/secrets-stream',
      trigger: 'pr_synced',
    });
    expect(again.skipped).toBe('no_targets');
    expect(again.findingsCreated).toBe(0);
    // And no forge call was spent asking.
    expect(calls).toEqual([]);
  });

  it('respects an explicit opt-out for the repo', async () => {
    await db.insert(security.repoScannerConfig).values({
      workspaceId,
      repoId,
      scannerKey: SECRETS_SCANNER_KEY,
      enabled: false,
      updatedBy: userId,
    });

    const result = await runSecretsStreamScan({
      db,
      provider: fakeProvider([]),
      workspaceId,
      repoId,
      repo: 'acme/secrets-stream',
      trigger: 'pr_synced',
    });
    expect(result.skipped).toBe('disabled');
  });
});
