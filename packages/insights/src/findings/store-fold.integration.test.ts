import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from './store.js';

// In-batch dedup-key collisions (W9-15).
//
// Before this, persistFindings built its key map from rows ALREADY IN THE
// DATABASE and never looked at the batch it was given. Two findings that keyed
// the same inside one run meant the first inserted, the second violated
// findings_workspace_repo_dedup_key, and the scanner's catch marked the whole
// run failed with NOTHING stored.
//
// The case is completely ordinary. The key buckets lines by ten
// (`floor(lineStart / 10)`), so two hits of one rule in one file collide
// whenever they land in the same ten-line window — which is what "two
// console.log calls a few lines apart" means. That shape took down the shipped
// logging_hygiene scanner on a three-line file. It survived a whole wave
// because fixtures trigger each rule once and real code does not.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w9-15-fp';

/** Hits of one rule in one file. Lines 4/7/9 share the ten-line bucket the key
 *  uses, which is what makes them collide — the collision is per bucket, not
 *  per file. */
function sameRuleAt(line: number, severity: number): IncomingFinding {
  return {
    dimension: 'logging',
    severity,
    confidence: 4,
    file: 'src/handler.js',
    lineStart: line,
    lineEnd: line,
    title: 'console.log in a request path',
    evidenceQuote: `src/handler.js:${line} — bpm-log-console-log`,
    rationale: 'A console call in a request path.',
    suggestedFix: null,
    scannerKey: 'logging_hygiene',
    ruleId: 'bpm-log-console-log',
    yields: null,
  };
}

describeIfLiveInfra('persistFindings folds in-batch duplicates (W9-15)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let scanRunId = 0;
  let userId = 0;

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
        authSubject: 'w9-15-user',
        forgeUserId: 'w9-15-user',
        login: 'w9-15-user',
      })
      .onConflictDoUpdate({
        target: [core.users.authProvider, core.users.authSubject],
        set: { login: 'w9-15-user' },
      })
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
        forgeRepoId: 'w9-15-repo',
        org: 'acme',
        name: 'fold',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'logging_hygiene',
        scannerVersion: 'w9-15-test',
        commitSha: 'w9-15-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    scanRunId = run!.id;
  });

  afterAll(async () => {
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('stores one row for three same-key findings instead of raising', async () => {
    // The exact shape that failed: one file, one rule, three lines.
    const result = await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings: [sameRuleAt(4, 2), sameRuleAt(7, 3), sameRuleAt(9, 1)],
      sweepScannerKey: 'logging_hygiene',
    });

    expect(result.created).toBe(1);
    // Never silent: a scanner that matched three lines and stored one row has
    // to be able to say so.
    expect(result.foldedDuplicates).toBe(2);

    const rows = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(rows).toHaveLength(1);

    // Worst case wins, so a fold cannot quietly downgrade a finding because a
    // milder sibling happened to be second in the batch.
    expect(rows[0]!.severity).toBe(3);
    // The stored row points at the FIRST occurrence in the file, not whichever
    // the engine emitted last.
    expect(rows[0]!.lineStart).toBe(4);
    expect(rows[0]!.lineEnd).toBe(9);

    // One finding seen once. occurrenceCount counts RUNS: a cluster of matching
    // lines must not report a sighting each after a single scan.
    expect(rows[0]!.occurrenceCount).toBe(1);
  });

  it('a second run of the same batch bumps the sighting once, not once per duplicate', async () => {
    const result = await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings: [sameRuleAt(4, 2), sameRuleAt(7, 3), sameRuleAt(9, 1)],
      sweepScannerKey: 'logging_hygiene',
    });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.foldedDuplicates).toBe(2);

    const rows = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrenceCount).toBe(2);
  });

  // 2026-10-27/28 walkthrough: improved rule wording (a sentence title, a
  // recommendation that says what to do) only reached new findings.
  it('a re-seen finding takes the latest title and recommendation', async () => {
    const better = {
      ...sameRuleAt(4, 2),
      title: 'A console call in a request path.',
      suggestedFix: 'Use the logger, which redacts and has levels.',
    };
    await persistFindings(db, {
      workspaceId,
      repoId,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings: [better],
      sweepScannerKey: 'logging_hygiene',
    });
    const rows = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('A console call in a request path.');
    expect(rows[0]!.recommendation).toBe('Use the logger, which redacts and has levels.');
  });
});
