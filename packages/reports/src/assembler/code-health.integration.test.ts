import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { codeHealthSections } from './code-health.js';
import type { ReportSection } from '../types/index.js';

// The Code Health report (W9-06, FR-REPORTS-8).
//
// It has to work in two states and SAY which one it is in — degraded (no
// scanner has run) and enriched. A report that hid the difference would let
// "no complexity findings" read as "no complex functions".

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

function byId(sections: readonly ReportSection[], id: string): ReportSection | undefined {
  return sections.find((s) => 'id' in s && s.id === id);
}

const FP = 'w9-06-fp';
const PIN = new Date('2026-08-19T12:00:00.000Z');

describeIfLiveInfra('code health report', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;

  const params = () => ({ workspaceId, repoIds: [repoId], snapshotAt: PIN });

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w9-06-user', forgeUserId: 'w9-06-user', login: 'w9-06-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w9-06-user' } })
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
        forgeRepoId: 'w9-06-repo',
        org: 'acme',
        name: 'health-report',
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
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('DEGRADES with the reason stated first', async () => {
    const sections = await codeHealthSections(db, params());
    const basis = byId(sections, 'code_health_basis');
    expect(basis?.kind).toBe('summary');
    const text = basis?.kind === 'summary' ? basis.markdown : '';
    expect(text).toContain('Debt signals only');
    // The distinction the whole report turns on.
    expect(text).toContain('not because they were measured and found clean');

    const posture = byId(sections, 'code_health_posture');
    expect(posture?.kind).toBe('no_data');
    expect(posture && 'reason' in posture ? posture.reason : '').toContain('not measured');
  });

  it('ENRICHES once the scanner has run, and says so', async () => {
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey: 'code_health_tools',
        scannerVersion: 'lizard@1.24.0 jscpd@4.3.0',
        commitSha: 'w9-06-sha',
        trigger: 'schedule',
        status: 'succeeded',
        startedAt: new Date('2026-08-10T00:00:00.000Z'),
        finishedAt: new Date('2026-08-10T00:05:00.000Z'),
      })
      .returning();

    await db.insert(read.metricSnapshots).values([
      {
        workspaceId,
        repoId,
        metricKey: 'ch_duplication_pct',
        window: 'all',
        value: '7.5',
        computedAt: new Date('2026-08-10T00:05:00.000Z'),
      },
      {
        workspaceId,
        repoId,
        metricKey: 'M13',
        window: '30d',
        value: '0.2',
        computedAt: new Date('2026-08-10T00:05:00.000Z'),
      },
    ]);

    await db.insert(read.findings).values({
      workspaceId,
      repoId,
      scanRunId: run!.id,
      analysisRunId: null,
      pullRequestId: null,
      dimension: 'code_health',
      severity: 3,
      confidence: 5,
      title: 'complexity.cyclomatic: parse',
      file: 'src/parse.ts',
      lineStart: 10,
      lineEnd: 90,
      evidence: 'src/parse.ts:10 — measured 23, threshold 20',
      recommendation: 'split it',
      tier: 1,
      dedupKey: 'w9-06-complexity',
      status: 'open',
      scannerKey: 'code_health_tools',
      ruleId: 'complexity.cyclomatic',
      firstSeenAt: new Date('2026-08-10T00:05:00.000Z'),
      lastSeenAt: new Date('2026-08-10T00:05:00.000Z'),
    });

    const sections = await codeHealthSections(db, params());
    const basis = byId(sections, 'code_health_basis');
    expect(basis?.kind === 'summary' ? basis.markdown : '').toContain(
      'includes scanner measurements',
    );

    const posture = byId(sections, 'code_health_posture');
    expect(posture?.kind).toBe('table');
    // The threshold travels beside the measurement, so a reader can argue with
    // the threshold rather than with the tool.
    expect(posture?.kind === 'table' ? posture.rows[0] : null).toEqual(['Duplication %', 7.5, 5]);

    const byRule = byId(sections, 'code_health_by_rule');
    expect(byRule?.kind === 'table' ? byRule.rows[0] : null).toEqual(['complexity.cyclomatic', 1]);
  });

  it('IGNORES anything after the pin', async () => {
    await db.insert(read.metricSnapshots).values({
      workspaceId,
      repoId,
      metricKey: 'ch_complexity_p90',
      window: 'all',
      value: '99',
      computedAt: new Date('2026-08-25T00:00:00.000Z'),
    });
    const sections = await codeHealthSections(db, params());
    const posture = byId(sections, 'code_health_posture');
    const rows = posture?.kind === 'table' ? posture.rows : [];
    expect(rows.find((r) => r[0] === 'Complexity p90')?.[1]).toBeNull();
  });

  it('footnotes what it does NOT measure', async () => {
    const sections = await codeHealthSections(db, params());
    const footnotes = byId(sections, 'code_health_footnotes');
    const text = footnotes?.kind === 'summary' ? footnotes.markdown : '';
    expect(text).toContain('Cognitive complexity and nesting depth are NOT measured');
    expect(text).toContain('Thresholds are defaults, not laws');
  });

  it('is byte-identical when regenerated', async () => {
    const a = await codeHealthSections(db, params());
    const b = await codeHealthSections(db, params());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
