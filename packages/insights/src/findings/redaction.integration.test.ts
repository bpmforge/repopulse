import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { assertRedacted, fingerprintSecret, redactSecretFinding } from './redaction.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// SC-29 secret redaction, proven against the DATABASE (W8-02).
//
// A unit test on the redaction function would only prove the function. This
// plants a secret, stores the finding a scanner would store, then greps every
// text column of the findings table for the plaintext — the same thing a
// database dump would contain.
//
// Fixtures are created here rather than borrowed from the seeder: an earlier
// version read whichever repo happened to exist and failed the moment the
// warehouse was empty, which is a test that depends on another test.

const PLANTED = 'AKIAIOSFODNN7EXAMPLE-w8-02-planted-secret-value';
const FP = 'w8-02-redaction-fp';

describeIfLiveInfra('secrets never reach the database (SC-29)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let runId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w8-02-user', forgeUserId: 'w8-02-user', login: 'w8-02-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-02-user' } })
      .returning();

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
        createdBy: user!.id,
      })
      .returning();

    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w8-02-repo',
        org: 'acme',
        name: 'redaction',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    // Parented on a SCAN run since W8-04. This fixture used to insert a
    // tier-2 analysis_runs row purely to satisfy a NOT NULL, which made a
    // scanner finding claim an LLM tier it never used; findings.analysis_run_id
    // is nullable now and the check constraint requires exactly one parent.
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'secrets',
        scannerVersion: 'secrets.v1',
        commitSha: 'w8-02-redaction-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    runId = run!.id;
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w8-02-user'));
    await db.$client.end();
  });

  it('stores a fingerprint and a location, never the value', async () => {
    const redacted = redactSecretFinding({
      file: 'src/config.ts',
      lineStart: 12,
      lineEnd: 12,
      ruleId: 'aws-access-key-id',
      secret: PLANTED,
    });

    expect(redacted.evidence).not.toContain(PLANTED);
    expect(redacted.fingerprint).toBe(fingerprintSecret(PLANTED));
    // Not even a masked prefix: "AKIA…" plus a repository name is often enough
    // to find the rest.
    expect(redacted.evidence).not.toContain(PLANTED.slice(0, 8));

    await db.insert(read.findings).values({
      workspaceId,
      repoId,
      scanRunId: runId,
      dimension: 'secrets',
      severity: 5,
      confidence: 5,
      title: 'AWS access key committed',
      file: redacted.file,
      lineStart: redacted.lineStart,
      lineEnd: redacted.lineEnd,
      evidence: redacted.evidence,
      recommendation: 'Rotate the key and remove it from history.',
      tier: 1,
      dedupKey: 'w8-02-secret-redaction',
      status: 'open',
      scannerKey: 'secrets',
      ruleId: redacted.ruleId,
    });

    // The real assertion: grep every text column, the way a dump would.
    const rows = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from findings
      where evidence like ${'%' + PLANTED + '%'}
         or title like ${'%' + PLANTED + '%'}
         or coalesce(recommendation, '') like ${'%' + PLANTED + '%'}
         or coalesce(file, '') like ${'%' + PLANTED + '%'}
    `);
    expect(rows[0]?.n, 'the planted secret must appear nowhere in the findings table').toBe(0);
  });

  it('refuses to store a finding that still contains the secret', () => {
    // The guard exists because redaction is easy to forget in a new scanner —
    // and an author who forgets should get an exception, not a leak.
    expect(() =>
      assertRedacted({ evidence: `found ${PLANTED} in config`, title: 'leak' }, PLANTED),
    ).toThrow(/never reach the database/);
    expect(() => assertRedacted({ evidence: 'aws key at src/a.ts:1' }, PLANTED)).not.toThrow();
  });
});
