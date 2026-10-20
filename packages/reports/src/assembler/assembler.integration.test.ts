import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { createReportAssembler } from './index.js';
import type { ReportParams, ReportSection } from '../types/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// Report assembler (W5-03, REPORTS.md §1/§2/§6).
//
// The determinism pin is the assertion that earns its keep. A report is
// evidence in a conversation about someone's team; one that quietly returns
// different numbers when regenerated is worse than no report at all.

describeIfLiveInfra('report assembler', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoId: number;
  const FP = 'w5-03-fp';

  const PIN = new Date('2026-08-10T00:00:00.000Z');
  const WINDOW_END = new Date('2026-08-10T00:00:00.000Z');

  function paramsFor(type: ReportParams['type']): ReportParams {
    return {
      type,
      workspaceId: String(workspaceId),
      repoIds: [String(repoId)],
      windowDays: 30,
      windowEnd: WINDOW_END.toISOString(),
      snapshotAt: PIN.toISOString(),
      weightsVersion: 'test-weights-1',
      catalogVersion: 'test-catalog-1',
    };
  }

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
        authSubject: 'w5-03-user',
        forgeUserId: 'w5-03-user',
        login: 'w5-03-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w5-03-user' } })
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
        forgeRepoId: 'w5-03-repo',
        org: 'acme',
        name: 'reporting',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    // Snapshots BEFORE the pin — the ones the report must use.
    const at = new Date('2026-08-09T00:00:00.000Z');
    await db.insert(read.metricSnapshots).values([
      {
        workspaceId,
        repoId,
        metricKey: 'M5',
        window: '30d',
        value: '0.80',
        dims: {},
        computedAt: at,
      },
      {
        workspaceId,
        repoId,
        metricKey: 'M9',
        window: '30d',
        value: '0.90',
        dims: { passRate: 0.9, prPassRate: 0.55, duration: { median: 7.5 }, topFlakiness: 0.1 },
        computedAt: at,
      },
      { workspaceId, repoId, metricKey: 'M8', window: '30d', value: '2', dims: {}, computedAt: at },
      {
        workspaceId,
        repoId,
        metricKey: 'M2',
        window: '30d',
        value: '0.7',
        dims: { files: [{ path: 'src/hot.ts', score: 0.7, gross: 400 }] },
        computedAt: at,
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w5-03-user'));
    await db.$client.end();
  });

  it('produces identical ReportData for identical params (the §2 determinism pin)', async () => {
    const assembler = createReportAssembler(db);
    const a = await assembler.assemble(paramsFor('repo_health'));
    const b = await assembler.assemble(paramsFor('repo_health'));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('IGNORES a snapshot computed after snapshotAt — the pin is the whole guarantee', async () => {
    const assembler = createReportAssembler(db);
    const before = await assembler.assemble(paramsFor('repo_health'));

    // A newer, wildly different M9. If the assembler read "latest" rather than
    // "latest at or before the pin", the CI section would move and a report
    // regenerated an hour later would contradict the one already sent.
    await db.insert(read.metricSnapshots).values({
      workspaceId,
      repoId,
      metricKey: 'M9',
      window: '30d',
      value: '0.10',
      dims: { passRate: 0.1, prPassRate: 0.1, duration: { median: 99 }, topFlakiness: 0.9 },
      computedAt: new Date('2026-08-11T00:00:00.000Z'),
    });

    const after = await assembler.assemble(paramsFor('repo_health'));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    // And with the pin moved forward, the SAME assembler does see it — proving
    // the first assertion is a real bound and not an accidental cache.
    const later = await assembler.assemble({
      ...paramsFor('repo_health'),
      snapshotAt: '2026-08-12T00:00:00.000Z',
    });
    expect(JSON.stringify(later)).not.toBe(JSON.stringify(before));
  });

  it('never emits a blank section — content or an explicit reason (FR-REPORTS-2)', async () => {
    const assembler = createReportAssembler(db);
    for (const type of ['repo_health', 'org_exec', 'delivery_dora'] as const) {
      const data = await assembler.assemble(paramsFor(type));
      expect(data.sections.length, `${type} has sections`).toBeGreaterThan(0);
      for (const section of data.sections) {
        if (section.kind === 'no_data') {
          // The reason is the whole point: "no findings" and "nothing has
          // analysed this repo" are different facts and must read differently.
          expect(section.reason.length, `${type}/${section.id} reason`).toBeGreaterThan(20);
        } else if (section.kind === 'table') {
          expect(section.columns.length, `${type}/${section.id} columns`).toBeGreaterThan(0);
        } else if (section.kind === 'summary') {
          expect(section.markdown.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("the findings section reports this repository's findings (W16-54)", async () => {
    // It was an unconditional no_data block reading "findings require the
    // analysis pass (W6)", with no query behind it, waves after W6 shipped —
    // while the SAME report opened by counting them. A reader saw "3 open
    // findings" on the first page and "no analysis data" on the last.
    const assembler = createReportAssembler(db);

    const empty = await assembler.assemble(paramsFor('repo_health'));
    // Not every section kind carries an id, so narrow before comparing.
    const findingsSection = (data: { sections: ReportSection[] }) =>
      data.sections.find((s) => 'id' in s && s.id === 'findings');

    const before = findingsSection(empty);
    expect(before?.kind).toBe('no_data');
    if (before?.kind === 'no_data') {
      // And it must not blame a wave: the honest reason is that nothing has
      // run or nothing was found.
      expect(before.reason).not.toMatch(/W6|Tier-1 only/);
    }

    const [run] = await db
      .insert(read.analysisRuns)
      .values({
        workspaceId,
        repoId,
        tier: 2,
        dimension: 'security',
        checklistVersion: 'test-1',
        modelId: 'test-model',
        status: 'succeeded',
        chunkCount: 1,
        promptTokens: 0,
        outputTokens: 0,
        startedAt: new Date('2026-08-01T00:00:00.000Z'),
      })
      .returning();
    await db.insert(read.findings).values({
      workspaceId,
      repoId,
      analysisRunId: run!.id,
      dimension: 'security',
      severity: 5,
      confidence: 5,
      title: 'SQL built by string concatenation',
      file: 'src/pay.ts',
      lineStart: 10,
      lineEnd: 12,
      evidence: 'db.query(x)',
      recommendation: 'parameterise',
      status: 'open',
      dedupKey: 'w16-54-dedup',
      tier: 2,
      firstSeenAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    // W20-15 (UX_TODO X-22): a dismissed one, a shadow-rule one and one raised
    // after the pin. None belongs in "Open findings" at this snapshot.
    const excluded = [
      { title: 'dismissed false positive', dedupKey: 'w20-15-dismissed', status: 'dismissed' },
      { title: 'shadow rule', dedupKey: 'w20-15-shadow', experimental: true },
      { title: 'after the pin', dedupKey: 'w20-15-late', firstSeenAt: new Date('2026-09-01') },
    ];
    await db.insert(read.findings).values(
      excluded.map((x) => ({
        workspaceId,
        repoId,
        analysisRunId: run!.id,
        dimension: 'security',
        severity: 5,
        confidence: 5,
        file: 'src/x.ts',
        evidence: 'e',
        recommendation: 'r',
        status: 'open',
        tier: 2,
        firstSeenAt: new Date('2026-08-01T00:00:00.000Z'),
        ...x,
      })),
    );

    const after = await assembler.assemble(paramsFor('repo_health'));
    const section = findingsSection(after);
    expect(section?.kind).toBe('table');
    if (section?.kind === 'table') {
      expect(JSON.stringify(section.rows)).toContain('SQL built by string concatenation');
      expect(JSON.stringify(section.rows)).toContain('src/pay.ts:10');
      for (const x of excluded) expect(JSON.stringify(section.rows)).not.toContain(x.title);
      // The id column the viewer links back to the finding (X-23).
      expect(section.findingIdColumn).toBe(5);
      expect(typeof section.rows[0]?.[5]).toBe('number');
      // W20-17: severity in words, as the security posture table prints it.
      expect(section.rows[0]?.[0]).toBe('critical');
    }

    await db.delete(read.findings).where(eq(read.findings.dedupKey, 'w16-54-dedup'));
    for (const x of excluded) {
      await db.delete(read.findings).where(eq(read.findings.dedupKey, x.dedupKey));
    }
    await db.delete(read.analysisRuns).where(eq(read.analysisRuns.id, run!.id));
  });

  it('decomposes the health score input by input, and carries the appendix', async () => {
    const data = await createReportAssembler(db).assemble(paramsFor('repo_health'));
    const breakdown = data.sections.find((s) => s.kind === 'score_breakdown');
    expect(breakdown, 'repo health must show its decomposition (FR-INSIGHTS-2)').toBeTruthy();

    // W20-12: the headline prints the 0–100 score and the band word the
    // dashboard uses — never "score (B)" (N-9 "signals, not grades").
    const headline =
      data.sections
        .map((s) => (s.kind === 'summary' ? s.markdown : ''))
        .find((md) => md.includes(' scored ')) ?? '';
    expect(headline).toMatch(/scored \*\*\d+ of 100 \((healthy|watch|needs attention)\)\*\*/);
    expect(headline).not.toMatch(/\([A-E]\)/);
    if (breakdown?.kind === 'score_breakdown') {
      // 'm5' is the input key buildHealthSubScores uses for review coverage —
      // asserted against the real key rather than a guessed label, so a rename
      // in insights fails here instead of silently matching nothing.
      const coverage = breakdown.rows.find((r) => r.input === 'm5');
      expect(coverage?.rawValue, 'the seeded M5 must appear as its own input row').toBe(0.8);
      expect(coverage?.subScore).toBe('reviewHygiene');
      expect(coverage?.contribution).not.toBeNull();
      // The stale-PR count and CI pass rate were seeded too, so the
      // decomposition must span more than one sub-score.
      expect(new Set(breakdown.rows.map((r) => r.subScore)).size).toBeGreaterThan(1);

      // W16-22. THE COLUMN MUST SUM TO THE SCORE.
      //
      // It wrote the SUB-SCORE's contribution onto every one of its input rows,
      // so a real report showed `ciHealth · topFlakiness · normalized 0 ·
      // contribution 9.29` — an input that scored zero credited with 9.29 — and
      // adding the column up gave 46.8 against a stated score of 38. This is
      // the exportable deliverable and its whole design invites the reader to
      // check the arithmetic, so this is the one number that must not be wrong.
      // Self-contained in the rows, deliberately: the score itself lives in the
      // summary markdown, and the first version of this check looked for a
      // `score` section that does not exist — so it silently skipped and passed
      // against the very bug it was written for.
      //
      // A sub-score is the equal-weight mean of its inputs' ramps, so each
      // group's contributions must sum to mean(normalized) x weight. With the
      // defect a group of n inputs summed to n times that.
      const groups = new Map<string, typeof breakdown.rows>();
      for (const row of breakdown.rows) {
        groups.set(row.subScore, [...(groups.get(row.subScore) ?? []), row]);
      }
      // The seed gives ciHealth two inputs (passRate + topFlakiness) and
      // reviewHygiene two (m5 + stalePrCount). Without a multi-input group this
      // assertion cannot fail, so guard the guard.
      expect(
        [...groups.values()].some((rows) => rows.length > 1),
        'this fixture must produce a sub-score with MORE THAN ONE input, or the sum check is vacuous',
      ).toBe(true);

      for (const [key, rows] of groups) {
        const summed = rows.reduce((acc, r) => acc + r.contribution, 0);
        const mean = rows.reduce((acc, r) => acc + (r.normalized ?? 0), 0) / rows.length;
        const expected = mean * (rows[0]?.weight ?? 0);
        // 0.5 rather than a tight epsilon: every stored figure is rounded to
        // two decimals before it reaches the report, so the parts drift from
        // the whole by fractions. The DEFECT was not a fraction — a group of n
        // inputs summed to n times its true contribution (44 became 88), so
        // this still discriminates by a wide margin.
        expect(
          Math.abs(summed - expected),
          `${key}: rows summed to ${summed}, but the sub-score contributes ${expected}`,
        ).toBeLessThan(0.5);
      }

      // And no row may claim a contribution while contributing nothing.
      for (const row of breakdown.rows) {
        if (row.normalized === 0) {
          expect(row.contribution, `${row.subScore}/${row.input} scored 0 but was credited`).toBe(
            0,
          );
        }
      }
    }
    // Appendix A comes from the catalog, so a definition in a report cannot
    // disagree with the tooltip the same reader saw on screen.
    expect(data.appendix.definitions.length).toBeGreaterThanOrEqual(12);
    expect(data.appendix.definitions.find((d) => d.id === 'M9')?.formula).toBeTruthy();
  });

  it('reports per-repo sync lag and partial coverage for the Basis box (§5.2)', async () => {
    const data = await createReportAssembler(db).assemble(paramsFor('repo_health'));
    const dq = data.dataQuality.find((d) => d.repoId === String(repoId));
    expect(dq?.phase).toBe('live');
    expect(dq?.partial).toBe(false);
    // 24h between the newest snapshot used (Aug 9) and windowEnd (Aug 10).
    expect(dq?.syncLagHours).toBe(24);
  });
});

// Gated like the suite above it. This block was a bare `describe`, so without
// DATABASE_URL it did not skip — it RAN, and `createDb(undefined as string)`
// took its beforeAll down with it. Invisible locally, where .env always has the
// variable; it would have failed the first CI run this repository ever gets.
describeIfLiveInfra('security posture report (W7-03, FR-REPORTS-4)', () => {
  const db2: Database = createDb(databaseUrl as string);
  let wsId = 0;

  beforeAll(async () => {
    const [ws] = await db2
      .select({ id: core.workspaces.id })
      .from(core.workspaces)
      .where(eq(core.workspaces.slug, 'default'))
      .limit(1);
    wsId = ws!.id;
  });
  afterAll(async () => {
    await db2.$client.end();
  });

  /** Self-contained params: the other suite's helper is scoped to its describe. */
  const securityParams = (): ReportParams => ({
    type: 'security_posture',
    workspaceId: String(wsId),
    repoIds: [],
    windowDays: 30,
    windowEnd: '2026-08-10T00:00:00.000Z',
    snapshotAt: '2026-08-10T00:00:00.000Z',
    weightsVersion: 'v1',
    catalogVersion: 'v1',
  });

  it('renders with TIER-1 ONLY data and says why each section is empty', async () => {
    // The report has to work before any analysis has run — that is the common
    // case for a new install, and it is exactly when a reader is most likely to
    // mistake "nothing found" for "nothing wrong".
    const data = await createReportAssembler(db2).assemble(securityParams());

    const ids = data.sections.map((s) =>
      s.kind === 'no_data' || s.kind === 'table' ? s.id : s.kind,
    );
    expect(ids).toContain('open_security_findings');
    expect(ids).toContain('review_bypass');
    expect(ids).toContain('egress_audit');
    expect(ids).toContain('finding_lifecycle');

    for (const section of data.sections) {
      if (section.kind === 'no_data') {
        // Every empty section explains itself. "No findings" and "not yet
        // analysed" are the same shape on a page and opposite facts in a room.
        expect(section.reason.length, `${section.id} reason`).toBeGreaterThan(40);
      }
    }
  });

  it('never lets an empty findings section read as "clean"', async () => {
    const data = await createReportAssembler(db2).assemble(securityParams());
    const findings = data.sections.find(
      (s) => s.kind === 'no_data' && s.id === 'open_security_findings',
    );
    if (findings?.kind === 'no_data') {
      expect(findings.reason).toMatch(/not yet examined|were RAISED/i);
    }
  });

  it('states plainly when nothing left the network', async () => {
    // The most reassuring empty section in the product — and the one most
    // easily confused with "we did not record it".
    const data = await createReportAssembler(db2).assemble(securityParams());
    const egress = data.sections.find((s) => s.kind === 'no_data' && s.id === 'egress_audit');
    if (egress?.kind === 'no_data') {
      expect(egress.reason).toMatch(/zero Tier-3 calls/);
      expect(egress.reason).toMatch(/written before each call/);
    }
  });

  it('carries Appendix B so the numbers can be interpreted without us', async () => {
    const data = await createReportAssembler(db2).assemble(securityParams());
    const appendix = data.sections.find((s) => s.kind === 'summary' && s.id === 'appendix_b');
    expect(appendix).toBeTruthy();
    if (appendix?.kind === 'summary') {
      expect(appendix.markdown).toMatch(/unverified/);
      expect(appendix.markdown).toMatch(/heuristic/);
    }
  });
});
