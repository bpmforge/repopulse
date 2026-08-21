import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { dedupKey } from './dedup.js';
import { rekeyFindings } from './rekey.js';

// Re-keying after the W8-16 normaliser change.
//
// The change is only safe if stored rows move with it. Without this, the next
// scan cannot find them, inserts duplicates, and sweeps the originals as
// resolved — taking every triage decision with them.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w8-16-fp';

describeIfLiveInfra('rekeyFindings', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  // Every finding needs exactly one parent run (findings_run_parent_check) —
  // "which scan found this" is the first question anyone asks of a finding.
  let scanRunId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w8-16-user', forgeUserId: 'w8-16-user', login: 'w8-16-user' })
      .onConflictDoUpdate({ target: [core.users.authProvider, core.users.authSubject], set: { login: 'w8-16-user' } })
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
        forgeRepoId: 'w8-16-repo',
        org: 'acme',
        name: 'rekey',
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
        scannerKey: 'dependency',
        scannerVersion: 'w8-16-test',
        commitSha: 'w8-16-sha',
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
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.authSubject, 'w8-16-user'));
  });

  it('rewrites a stale key in place, keeping the row and its history', async () => {
    const evidence = 'CVE-2020-11023 in lodash at app.ts:42';
    // The key the OLD normaliser produced — digits stripped everywhere.
    const staleKey = 'w8-16-stale-key-standing-in-for-the-old-hash';

    const [row] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        dimension: 'dependency',
        severity: 4,
        confidence: 5,
        file: null,
        lineStart: null,
        lineEnd: null,
        title: 'jQuery XSS',
        evidence,
        recommendation: 'upgrade',
        status: 'confirmed',
        dedupKey: staleKey,
        occurrenceCount: 7,
        tier: 1,
        scanRunId,
      })
      .returning();

    const result = await rekeyFindings(db, workspaceId);
    expect(result.rewritten).toBeGreaterThan(0);

    const [after] = await db
      .select()
      .from(read.findings)
      .where(eq(read.findings.id, row!.id));

    // Same row: the id, the triage status and the occurrence count all survive.
    expect(after!.id).toBe(row!.id);
    expect(after!.status).toBe('confirmed');
    expect(after!.occurrenceCount).toBe(7);
    expect(after!.dedupKey).toBe(
      dedupKey({ dimension: 'dependency', file: null, lineStart: null, evidenceQuote: evidence }),
    );
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    const again = await rekeyFindings(db, workspaceId);
    expect(again.rewritten).toBe(0);
  });

  it('REPORTS a collision rather than resolving it silently', async () => {
    // Two rows that the old normaliser would have kept apart but which now
    // key identically. Choosing a survivor is a decision about someone's
    // triage history, not something a migration should make quietly.
    const shared = 'timeout( 3000 ) in worker.ts';
    for (const [i, quote] of [shared, 'timeout( 5000 ) in worker.ts'].entries()) {
      await db.insert(read.findings).values({
        workspaceId,
        repoId,
        dimension: 'code_health',
        severity: 2,
        confidence: 5,
        file: 'worker.ts',
        lineStart: null,
        lineEnd: null,
        title: `collide ${i}`,
        evidence: quote,
        recommendation: 'x',
        status: 'open',
        dedupKey: `w8-16-collide-${i}`,
        tier: 1,
        scanRunId,
      });
    }

    const result = await rekeyFindings(db, workspaceId);
    expect(result.collisions.length).toBe(1);
    expect(result.collisions[0]!.keptId).not.toBe(result.collisions[0]!.droppedId);
  });
});
