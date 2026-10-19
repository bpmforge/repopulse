import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { axisSection, riskSections } from './risk.js';
import type { ReportSection } from '../types/index.js';

// The risk opener (W9-12, RISK_MODEL.md §5, FR-RISK-6).

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

function byId(sections: readonly ReportSection[], id: string): ReportSection | undefined {
  return sections.find((s) => 'id' in s && s.id === id);
}

const FP = 'w9-12-fp';
const PIN = new Date('2026-08-19T12:00:00.000Z');
const PREVIOUS = new Date('2026-08-12T12:00:00.000Z');

describeIfLiveInfra('risk opener', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let runId = 0;
  let findingId = 0;

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
        authSubject: 'w9-12-user',
        forgeUserId: 'w9-12-user',
        login: 'w9-12-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w9-12-user' } })
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
        forgeRepoId: 'w9-12-repo',
        org: 'acme',
        name: 'risk-report',
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
        scannerKey: 'semgrep',
        scannerVersion: 'test',
        commitSha: 'w9-12-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    runId = run!.id;

    const [priced] = await db
      .insert(read.findings)
      .values({
        workspaceId,
        repoId,
        scanRunId: runId,
        analysisRunId: null,
        pullRequestId: null,
        dimension: 'sast',
        severity: 5,
        confidence: 5,
        title: 'eval on request input',
        file: 'src/app.js',
        lineStart: 3,
        lineEnd: 3,
        evidence: 'e',
        recommendation: 'r',
        tier: 1,
        dedupKey: 'w9-12-priced',
        status: 'open',
        scannerKey: 'semgrep',
        ruleId: 'bpm-js-eval-dynamic',
        effectiveRisk: '80.00',
        riskBand: 'act',
        riskFactors: { H: 1, L: 0.8, X: 1, inputs: {}, model_version: 'risk_model.v1' },
        firstSeenAt: new Date('2026-08-15T00:00:00.000Z'),
        lastSeenAt: new Date('2026-08-15T00:00:00.000Z'),
      })
      .returning();
    findingId = priced!.id;

    // An UNPRICED finding, and a SHADOW one. Neither may appear in the table.
    await db.insert(read.findings).values([
      {
        workspaceId,
        repoId,
        scanRunId: runId,
        analysisRunId: null,
        pullRequestId: null,
        dimension: 'code_health',
        severity: 2,
        confidence: 3,
        title: 'unpriced finding',
        file: 'src/b.js',
        lineStart: 1,
        lineEnd: 1,
        evidence: 'e',
        recommendation: 'r',
        tier: 1,
        dedupKey: 'w9-12-unpriced',
        status: 'open',
        firstSeenAt: new Date('2026-08-14T00:00:00.000Z'),
        lastSeenAt: new Date('2026-08-14T00:00:00.000Z'),
      },
      {
        workspaceId,
        repoId,
        scanRunId: runId,
        analysisRunId: null,
        pullRequestId: null,
        dimension: 'code_health',
        severity: 5,
        confidence: 5,
        title: 'shadow rule finding',
        file: 'src/c.js',
        lineStart: 1,
        lineEnd: 1,
        evidence: 'e',
        recommendation: 'r',
        tier: 1,
        dedupKey: 'w9-12-shadow',
        status: 'open',
        experimental: true,
        effectiveRisk: '99.00',
        riskBand: 'act',
        firstSeenAt: new Date('2026-08-14T00:00:00.000Z'),
        lastSeenAt: new Date('2026-08-14T00:00:00.000Z'),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
    await db.delete(read.findings).where(eq(read.findings.repoId, repoId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('opens with the top risks, band AND raw severity in the row', async () => {
    const sections = await riskSections(db, {
      workspaceId,
      repoIds: [repoId],
      snapshotAt: PIN,
      previousSnapshotAt: null,
    });
    const top = byId(sections, 'top_risks');
    expect(top?.kind).toBe('table');
    const rows = top?.kind === 'table' ? top.rows : [];
    // The composite never appears without the number a reader already
    // understands.
    expect(rows[0]).toEqual([
      'act',
      80,
      5,
      'eval on request input',
      'acme/risk-report · src/app.js',
    ]);
  });

  it('EXCLUDES a shadow-rule finding, even at risk 99', async () => {
    // A document sent to an auditor must not carry findings from a rule still
    // being trialled.
    const sections = await riskSections(db, {
      workspaceId,
      repoIds: [repoId],
      snapshotAt: PIN,
      previousSnapshotAt: null,
    });
    const top = byId(sections, 'top_risks');
    const titles = top?.kind === 'table' ? top.rows.map((r) => r[3]) : [];
    expect(titles).not.toContain('shadow rule finding');
  });

  it('carries the denominator in its own section', async () => {
    const sections = await riskSections(db, {
      workspaceId,
      repoIds: [repoId],
      snapshotAt: PIN,
      previousSnapshotAt: null,
    });
    const counts = byId(sections, 'risk_counts');
    const text = counts?.kind === 'summary' ? counts.markdown : '';
    expect(text).toMatch(/\*\*2 open findings\*\*/);
    // Unpriced is reported, not folded into track.
    expect(text).toMatch(/1 not yet priced/);
    expect(text).toContain('not judged low-risk');
  });

  it('says there is nothing to compare on a FIRST report', async () => {
    const sections = await riskSections(db, {
      workspaceId,
      repoIds: [repoId],
      snapshotAt: PIN,
      previousSnapshotAt: null,
    });
    const movement = byId(sections, 'risk_movement');
    expect(movement?.kind).toBe('no_data');
    expect(movement && 'reason' in movement ? movement.reason : '').toMatch(/first report/);
  });

  it('reads movement from the reprice EVENTS between the two pins', async () => {
    // The same mechanism the plans movement section uses: the events are what
    // the product recorded at the time, so the comparison is reproducible
    // rather than recomputed from today's data against a remembered number.
    await db.insert(read.findingEvents).values({
      workspaceId,
      findingId,
      fromStatus: 'open',
      toStatus: 'open',
      actor: null,
      reason: 'reprice: risk band schedule → act',
      at: new Date('2026-08-16T00:00:00.000Z'),
    });

    const sections = await riskSections(db, {
      workspaceId,
      repoIds: [repoId],
      snapshotAt: PIN,
      previousSnapshotAt: PREVIOUS,
    });
    const movement = byId(sections, 'risk_movement');
    expect(movement?.kind).toBe('table');
    const rows = movement?.kind === 'table' ? movement.rows : [];
    expect(rows.find((r) => r[0] === 'Climbed into act')?.[1]).toBe(1);
  });

  it('IGNORES an event after the pin', async () => {
    await db.insert(read.findingEvents).values({
      workspaceId,
      findingId,
      fromStatus: 'open',
      toStatus: 'open',
      actor: null,
      reason: 'reprice: risk band act → track',
      at: new Date('2026-08-25T00:00:00.000Z'),
    });

    const sections = await riskSections(db, {
      workspaceId,
      repoIds: [repoId],
      snapshotAt: PIN,
      previousSnapshotAt: PREVIOUS,
    });
    const movement = byId(sections, 'risk_movement');
    const rows = movement?.kind === 'table' ? movement.rows : [];
    expect(rows.find((r) => r[0] === 'Dropped out of act')?.[1]).toBe(0);
  });

  it('is byte-identical when regenerated', async () => {
    const args = { workspaceId, repoIds: [repoId], snapshotAt: PIN, previousSnapshotAt: PREVIOUS };
    const a = await riskSections(db, args);
    const b = await riskSections(db, args);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('the axis row', () => {
  it('renders a 0–100 score and band word per scored axis, never a letter (W20-12, N-9)', () => {
    const section = axisSection([
      { key: 'security', normalized: 90 },
      { key: 'codeHealth', normalized: 55.4 },
    ]);
    expect(section.kind).toBe('table');
    if (section.kind !== 'table') return;
    expect(section.columns).not.toContain('Letter');
    const rows = section.rows;
    expect(rows.find((r) => r[0] === 'Security')?.slice(1, 3)).toEqual([90, 'healthy']);
    expect(rows.find((r) => r[0] === 'Code Health')?.slice(1, 3)).toEqual([55, 'watch']);
    for (const row of rows) expect(row[2]).not.toMatch(/^[A-E]$/);
  });

  it('shows an ABSENT axis with a basis line, never a grade', () => {
    // FR-INSIGHTS-3: a letter for an axis nobody measured is a fake grade.
    const section = axisSection([{ key: 'security', normalized: 90 }]);
    const rows = section.kind === 'table' ? section.rows : [];
    const codeHealth = rows.find((r) => r[0] === 'Code Health');
    expect(codeHealth?.[1]).toBeNull();
    expect(codeHealth?.[2]).toBe('—');
    expect(String(codeHealth?.[3])).toMatch(/not measured for this scope/);
  });

  it('renders NOTHING rather than a grid of dashes when no sub-score exists', () => {
    const section = axisSection([]);
    expect(section.kind).toBe('no_data');
    expect(section.kind === 'no_data' ? section.reason : '').toMatch(/grade nobody measured/);
  });
});
