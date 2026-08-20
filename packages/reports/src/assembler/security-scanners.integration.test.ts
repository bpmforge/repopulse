import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { chainAppendix, scannerPostures, scannerSections } from './security-posture.js';
import type { ReportSection } from '../types/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// Scanner sections of the Security Posture report (W8-11, FR-SEC-10 /
// FR-REPORTS-4 / FR-REPORTS-6).
//
// This report is the one most likely to be read by someone who did not run it.
// Every assertion below is about a SENTENCE being right rather than a number:
// "switched off", "enabled but never run" and "ran and found nothing" are three
// different facts, and a reader in a meeting cannot recover the difference from
// a zero.

/** score_breakdown sections carry no id, so narrow before comparing. */
function byId(sections: readonly ReportSection[], id: string): ReportSection | undefined {
  return sections.find((section) => 'id' in section && section.id === id);
}

const FP = 'w8-11-fp';
const PIN = new Date('2026-08-19T12:00:00.000Z');

describeIfLiveInfra('security posture — scanner sections', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let firstRunId = 0;
  let secondRunId = 0;

  const params = () => ({
    workspaceId,
    repoIds: [repoId],
    snapshotAt: PIN,
    windowStart: new Date('2026-07-19T00:00:00.000Z'),
  });

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w8-11-user', forgeUserId: 'w8-11-user', login: 'w8-11-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w8-11-user' } })
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
        forgeRepoId: 'w8-11-repo',
        org: 'acme',
        name: 'posture',
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
    await db
      .delete(security.repoScannerConfig)
      .where(eq(security.repoScannerConfig.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('DEGRADES to a stated reason when no scanner has run', async () => {
    // The W7-03 Tier-1-only rendering. It must say "not yet scanned" — a report
    // that simply omits the scanner sections reads as though the scanners ran.
    const sections = await scannerSections(db, params());
    const posture = byId(sections, 'scanner_posture');
    expect(posture?.kind).toBe('no_data');
    expect(posture && 'reason' in posture ? posture.reason : '').toMatch(/not yet scanned/i);
  });

  it('renders a section per scanner once runs and findings exist', async () => {
    const [first] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'secrets',
        scannerVersion: 'secrets.v1',
        commitSha: 'w8-11-sha-1',
        trigger: 'pr_synced',
        status: 'succeeded',
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
        finishedAt: new Date('2026-08-01T00:01:00.000Z'),
      })
      .returning();
    firstRunId = first!.id;

    const [second] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'secrets',
        scannerVersion: 'secrets.v1',
        commitSha: 'w8-11-sha-2',
        trigger: 'pr_synced',
        status: 'succeeded',
        startedAt: new Date('2026-08-10T00:00:00.000Z'),
        finishedAt: new Date('2026-08-10T00:01:00.000Z'),
      })
      .returning();
    secondRunId = second!.id;

    const finding = (dedupKey: string, severity: number, firstSeenAt: Date, runId: number) => ({
      workspaceId,
      repoId,
      scanRunId: runId,
      analysisRunId: null,
      pullRequestId: null,
      dimension: 'secrets',
      severity,
      confidence: 4,
      title: `Secret ${dedupKey}`,
      file: 'src/config.ts',
      lineStart: 1,
      lineEnd: 1,
      evidence: 'sha256 fingerprint at src/config.ts:1',
      recommendation: 'Rotate it.',
      tier: 1,
      dedupKey,
      status: 'open',
      scannerKey: 'secrets',
      ruleId: 'aws-access-key-id',
      firstSeenAt,
      lastSeenAt: firstSeenAt,
    });

    await db.insert(read.findings).values([
      // Before the previous run finished: old news.
      finding('w8-11-a', 5, new Date('2026-07-30T00:00:00.000Z'), firstRunId),
      // After it: new since the previous run.
      finding('w8-11-b', 3, new Date('2026-08-05T00:00:00.000Z'), secondRunId),
    ]);

    const postures = await scannerPostures(db, params());
    expect(postures).toHaveLength(1);
    const secrets = postures[0]!;
    expect(secrets.scannerKey).toBe('secrets');
    expect(secrets.openTotal).toBe(2);
    expect(secrets.bySeverity[5]).toBe(1);
    expect(secrets.scannerVersion).toBe('secrets.v1');
    // Counted against the PREVIOUS run's finish, not the latest one's: "new
    // since we last looked" is the question a reader is asking.
    expect(secrets.newSincePreviousRun).toBe(1);

    const sections = await scannerSections(db, params());
    const table = byId(sections, 'scanner_secrets');
    expect(table?.kind).toBe('table');
    const top = byId(sections, 'scanner_secrets_top');
    expect(top?.kind).toBe('table');
    // Highest severity first.
    expect(top?.kind === 'table' ? top.rows[0]?.[0] : null).toBe(5);
  });

  it('reports null, not zero, when there is no previous run to compare against', async () => {
    // A brand-new scanner reporting "0 new" would say nothing changed when in
    // fact nothing had ever been measured.
    await db.insert(security.scanRuns).values({
      workspaceId,
      repoId,
      scannerKey: 'semgrep',
      scannerVersion: 'opengrep-1.25.0',
      commitSha: 'w8-11-sha-3',
      trigger: 'schedule',
      status: 'succeeded',
      startedAt: new Date('2026-08-11T00:00:00.000Z'),
      finishedAt: new Date('2026-08-11T00:05:00.000Z'),
    });

    const postures = await scannerPostures(db, params());
    const semgrep = postures.find((p) => p.scannerKey === 'semgrep');
    expect(semgrep?.newSincePreviousRun).toBeNull();
    expect(semgrep?.openTotal).toBe(0);
  });

  it('says SWITCHED OFF for a scanner with an explicit false, and null-config is not off', async () => {
    // Absent config is not "disabled": an unconfigured scanner runs on the
    // workspace default, and printing "not enabled" for it would be a claim the
    // warehouse cannot support.
    await db.insert(security.repoScannerConfig).values({
      workspaceId,
      repoId,
      scannerKey: 'dependency',
      enabled: false,
      updatedBy: userId,
    });

    const postures = await scannerPostures(db, params());
    expect(postures.find((p) => p.scannerKey === 'dependency')?.enabled).toBe(false);
    expect(postures.find((p) => p.scannerKey === 'secrets')?.enabled).toBeNull();

    const sections = await scannerSections(db, params());
    const off = byId(sections, 'scanner_dependency');
    expect(off?.kind).toBe('no_data');
    expect(off && 'reason' in off ? off.reason : '').toMatch(/switched off/i);
    // And it says what that costs the reader: the zeros elsewhere exclude it.
    expect(off && 'reason' in off ? off.reason : '').toMatch(/excludes/i);
  });

  it('IGNORES everything after snapshotAt — the pin is the whole guarantee', async () => {
    await db.insert(security.scanRuns).values({
      workspaceId,
      repoId,
      scannerKey: 'iac',
      scannerVersion: 'later',
      commitSha: 'w8-11-sha-late',
      trigger: 'manual',
      status: 'succeeded',
      // AFTER the pin.
      startedAt: new Date('2026-08-20T00:00:00.000Z'),
      finishedAt: new Date('2026-08-20T00:01:00.000Z'),
    });

    const postures = await scannerPostures(db, params());
    expect(postures.map((p) => p.scannerKey)).not.toContain('iac');
  });

  it('is byte-identical when regenerated with identical params (FR-REPORTS-6)', async () => {
    // The assertion that earns its keep: a report is evidence in a conversation
    // about someone's team, and one that quietly returns different numbers when
    // regenerated is worse than no report at all.
    const a = await scannerSections(db, params());
    const b = await scannerSections(db, params());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('says chains have not been LOOKED for, rather than that none exist', async () => {
    const chains = await chainAppendix(db, params());
    expect(chains).toEqual([]);
    const sections = await scannerSections(db, params());
    const appendix = byId(sections, 'chains_appendix');
    expect(appendix?.kind).toBe('no_data');
    expect(appendix && 'reason' in appendix ? appendix.reason : '').toMatch(/LOOKED for/);
  });

  it('ranks a chain by its WORST step, not an average', async () => {
    await db.insert(read.findings).values([
      {
        workspaceId,
        repoId,
        scanRunId: secondRunId,
        analysisRunId: null,
        pullRequestId: null,
        dimension: 'chain',
        severity: 5,
        confidence: 4,
        title: 'Credential reaches production',
        file: null,
        lineStart: null,
        lineEnd: null,
        evidence: 'chain step',
        recommendation: 'Break the chain.',
        tier: 1,
        dedupKey: 'w8-11-chain-1',
        status: 'open',
        scannerKey: 'attack_chainer',
        chainId: 'chain-1',
        firstSeenAt: new Date('2026-08-05T00:00:00.000Z'),
        lastSeenAt: new Date('2026-08-05T00:00:00.000Z'),
      },
      {
        workspaceId,
        repoId,
        scanRunId: secondRunId,
        analysisRunId: null,
        pullRequestId: null,
        dimension: 'chain',
        severity: 2,
        confidence: 4,
        title: 'Low-severity entry point',
        file: null,
        lineStart: null,
        lineEnd: null,
        evidence: 'chain step',
        recommendation: 'Break the chain.',
        tier: 1,
        dedupKey: 'w8-11-chain-2',
        status: 'open',
        scannerKey: 'attack_chainer',
        chainId: 'chain-1',
        firstSeenAt: new Date('2026-08-05T00:00:00.000Z'),
        lastSeenAt: new Date('2026-08-05T00:00:00.000Z'),
      },
    ]);

    const chains = await chainAppendix(db, params());
    expect(chains).toHaveLength(1);
    // Not 3.5. An average would let one critical link hide behind trivial ones.
    expect(chains[0]?.severity).toBe(5);
    expect(chains[0]?.steps).toHaveLength(2);
  });
});
