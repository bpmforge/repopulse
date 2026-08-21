import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { dedupKey } from './dedup.js';
import { remapAntiSlopDimension } from './remap-dimension.js';

// Moving anti_slop's findings to the `slop` dimension (W9-16).
//
// The assertion that earns its keep is not that the dimension changed — it is
// that the ROW survived. dedupKey hashes the dimension, so this migration
// rewrites the identity of every affected finding. Get it wrong and the next
// scan matches nothing, inserts a duplicate, and sweeps the original as
// resolved, taking its occurrence count and someone's triage decision with it.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w9-16-fp';

describeIfLiveInfra('remapAntiSlopDimension', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let scanRunId = 0;
  let userId = 0;
  let slopId = 0;
  let toolsId = 0;

  const SLOP_EVIDENCE = 'src/wrapper.ts:12 — bpm-slop-delegation-only';
  const TOOLS_EVIDENCE = 'src/big.ts:40 — measured 23, threshold 10';

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
        authSubject: 'w9-16-user',
        forgeUserId: 'w9-16-user',
        login: 'w9-16-user',
      })
      .onConflictDoUpdate({
        target: [core.users.authProvider, core.users.authSubject],
        set: { login: 'w9-16-user' },
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
        forgeRepoId: 'w9-16-repo',
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

    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'anti_slop',
        scannerVersion: 'w9-16-test',
        commitSha: 'w9-16-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    scanRunId = run!.id;

    // A misfiled anti_slop row, carrying the history the migration must not
    // lose: someone confirmed it, and it has been seen seven times.
    const [slop] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        scanRunId,
        pullRequestId: null,
        dimension: 'code_health',
        severity: 3,
        confidence: 4,
        title: 'Delegation-only wrapper',
        file: 'src/wrapper.ts',
        lineStart: 12,
        lineEnd: 12,
        evidence: SLOP_EVIDENCE,
        recommendation: 'Call the wrapped function directly.',
        tier: 1,
        scannerKey: 'anti_slop',
        ruleId: 'bpm-slop-delegation-only',
        dedupKey: dedupKey({
          dimension: 'code_health',
          file: 'src/wrapper.ts',
          lineStart: 12,
          evidenceQuote: SLOP_EVIDENCE,
          scannerKey: 'anti_slop',
          ruleId: 'bpm-slop-delegation-only',
        }),
        status: 'confirmed',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        occurrenceCount: 7,
      })
      .returning();
    slopId = slop!.id;

    // A genuine code_health row from a DIFFERENT scanner. `code_health` is
    // written by three scanners and only anti_slop's rows are misfiled, so this
    // one must not move — a remap by dimension alone would drag it along.
    const [tools] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        scanRunId,
        pullRequestId: null,
        dimension: 'code_health',
        severity: 2,
        confidence: 5,
        title: 'High cyclomatic complexity',
        file: 'src/big.ts',
        lineStart: 40,
        lineEnd: 40,
        evidence: TOOLS_EVIDENCE,
        recommendation: 'Split the function.',
        tier: 1,
        scannerKey: 'code_health_tools',
        ruleId: 'lizard.ccn',
        dedupKey: dedupKey({
          dimension: 'code_health',
          file: 'src/big.ts',
          lineStart: 40,
          evidenceQuote: TOOLS_EVIDENCE,
          scannerKey: 'code_health_tools',
          ruleId: 'lizard.ccn',
        }),
        status: 'open',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        occurrenceCount: 2,
      })
      .returning();
    toolsId = tools!.id;
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

  it('moves anti_slop rows and keeps id, triage status and occurrence count', async () => {
    const result = await remapAntiSlopDimension(db, workspaceId);
    expect(result.remapped).toBe(1);
    expect(result.rekey.collisions).toEqual([]);

    const [row] = await db.select().from(read.findings).where(eq(read.findings.id, slopId));

    // The SAME row — not a replacement wearing the same evidence.
    expect(row!.id).toBe(slopId);
    expect(row!.dimension).toBe('slop');
    // The three things a botched migration silently destroys.
    expect(row!.status).toBe('confirmed');
    expect(row!.occurrenceCount).toBe(7);
    expect(row!.firstSeenAt).not.toBeNull();

    // And the key now matches what the NEXT scan will compute for this finding.
    // Without this the row is unreachable and the scan duplicates it.
    expect(row!.dedupKey).toBe(
      dedupKey({
        dimension: 'slop',
        file: 'src/wrapper.ts',
        lineStart: 12,
        evidenceQuote: SLOP_EVIDENCE,
        scannerKey: 'anti_slop',
        ruleId: 'bpm-slop-delegation-only',
      }),
    );
  });

  it('leaves another scanner’s code_health findings alone', async () => {
    const [row] = await db.select().from(read.findings).where(eq(read.findings.id, toolsId));
    expect(row!.dimension).toBe('code_health');
    expect(row!.occurrenceCount).toBe(2);
    expect(row!.dedupKey).toBe(
      dedupKey({
        dimension: 'code_health',
        file: 'src/big.ts',
        lineStart: 40,
        evidenceQuote: TOOLS_EVIDENCE,
        scannerKey: 'code_health_tools',
        ruleId: 'lizard.ccn',
      }),
    );
  });

  it('is idempotent — a second run moves nothing and changes no key', async () => {
    const before = await db.select().from(read.findings).where(eq(read.findings.id, slopId));
    const result = await remapAntiSlopDimension(db, workspaceId);

    expect(result.remapped).toBe(0);
    expect(result.rekey.rewritten).toBe(0);
    expect(result.rekey.collisions).toEqual([]);

    const after = await db.select().from(read.findings).where(eq(read.findings.id, slopId));
    expect(after[0]!.dedupKey).toBe(before[0]!.dedupKey);
    expect(after[0]!.occurrenceCount).toBe(7);
  });
});
