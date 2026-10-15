import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, read, security, type Database } from '@repopulse/shared';
import { repriceFindings, hotspotPercentiles } from './reprice.js';
import { readImportGraph, writeImportGraph, type ImportGraphSnapshot } from './import-graph.js';

// Nightly reprice (W9-09, RISK_MODEL.md §3, FR-RISK-4).

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const FP = 'w9-09-fp';

describeIfLiveInfra('risk.reprice', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId = 0;
  let repoId = 0;
  let userId = 0;
  let runId = 0;
  let coldFindingId = 0;
  let hotFindingId = 0;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;

    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w9-09-user', forgeUserId: 'w9-09-user', login: 'w9-09-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w9-09-user' } })
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
        forgeRepoId: 'w9-09-repo',
        org: 'acme',
        name: 'risk',
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
        commitSha: 'w9-09-sha',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    runId = run!.id;

    const finding = async (dedupKey: string, file: string, severity: number) => {
      const [row] = await db
        .insert(read.findings)
        .values({
          workspaceId,
          repoId,
          scanRunId: runId,
          analysisRunId: null,
          pullRequestId: null,
          dimension: 'sast',
          severity,
          confidence: 5,
          title: `finding ${dedupKey}`,
          file,
          lineStart: 1,
          lineEnd: 1,
          evidence: 'e',
          recommendation: 'r',
          tier: 1,
          dedupKey,
          status: 'open',
          scannerKey: 'semgrep',
          ruleId: 'bpm-js-eval-dynamic',
          verifyStatus: 'confirmed',
        })
        .returning();
      return row!.id;
    };

    hotFindingId = await finding('w9-09-hot', 'src/hot.ts', 5);
    coldFindingId = await finding('w9-09-cold', 'src/cold.ts', 5);
  });

  afterAll(async () => {
    await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
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

  it('prices every open finding and stores the decomposition beside the score', async () => {
    const result = await repriceFindings({
      db,
      workspaceId,
      repoId,
      hotspots: new Map([
        ['src/hot.ts', 1],
        ['src/cold.ts', 0],
      ]),
      ruleFpRates: new Map([['bpm-js-eval-dynamic', 0]]),
    });
    expect(result.priced).toBe(2);

    const rows = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    for (const row of rows) {
      expect(row.effectiveRisk).not.toBeNull();
      expect(row.riskBand).not.toBeNull();
      const factors = row.riskFactors as { H: number; L: number; X: number };
      // The score reproduces from what is stored — the popover's promise.
      expect(Math.round(100 * factors.H * factors.L * factors.X * 100) / 100).toBe(
        Number(row.effectiveRisk),
      );
    }

    const hot = rows.find((r) => r.id === hotFindingId);
    const cold = rows.find((r) => r.id === coldFindingId);
    // Same severity, same rule, same confidence — the hot file outranks the
    // cold one, and the cold one is still on the list.
    expect(Number(hot?.effectiveRisk)).toBeGreaterThan(Number(cold?.effectiveRisk));
    expect(Number(cold?.effectiveRisk)).toBeGreaterThan(0);
  });

  it('audits a BAND crossing exactly once, and not a score wobble', async () => {
    const before = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.findingId, coldFindingId));

    // The cold file warms up: track → act.
    const warmed = await repriceFindings({
      db,
      workspaceId,
      repoId,
      hotspots: new Map([
        ['src/hot.ts', 1],
        ['src/cold.ts', 1],
      ]),
      ruleFpRates: new Map([['bpm-js-eval-dynamic', 0]]),
    });
    expect(warmed.bandChanges.some((c) => c.findingId === coldFindingId)).toBe(true);

    const after = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.findingId, coldFindingId));
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1]?.reason).toMatch(/reprice: risk band/);
  });

  it('is IDEMPOTENT: a second run with the same inputs writes no new events', async () => {
    const inputs = {
      db,
      workspaceId,
      repoId,
      hotspots: new Map([
        ['src/hot.ts', 1],
        ['src/cold.ts', 1],
      ]),
      ruleFpRates: new Map([['bpm-js-eval-dynamic', 0]]),
    };
    await repriceFindings(inputs);
    const before = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.workspaceId, workspaceId));

    const again = await repriceFindings(inputs);
    expect(again.bandChanges).toEqual([]);

    const after = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.workspaceId, workspaceId));
    expect(after.length).toBe(before.length);
  });

  it('reads hotspot percentiles from the latest M2 snapshot', async () => {
    await db.insert(read.metricSnapshots).values({
      workspaceId,
      repoId,
      metricKey: 'M2',
      window: '30d',
      value: '1',
      dims: {
        files: [
          { path: 'src/cold.ts', score: 0.1 },
          { path: 'src/warm.ts', score: 0.5 },
          { path: 'src/hot.ts', score: 0.9 },
        ],
      },
    });

    const percentiles = await hotspotPercentiles(db, workspaceId, repoId);
    // Percentile WITHIN the repo: a hotspot score means nothing across
    // repositories of different sizes.
    expect(percentiles.get('src/cold.ts')).toBe(0);
    expect(percentiles.get('src/hot.ts')).toBe(1);
    expect(percentiles.get('src/warm.ts')).toBeCloseTo(0.5, 10);
  });

  it('returns an empty map when no M2 snapshot has dims', async () => {
    // Absent, not zero: an empty map makes every file "unknown", which the
    // pricer treats as full exposure rather than as a cold file.
    const other = await hotspotPercentiles(db, workspaceId, repoId + 99_999);
    expect(other.size).toBe(0);
  });

  it('prices import-graph exposure from the stored graph and persists the why (W18-25)', async () => {
    // hot.ts is imported by 14 modules, cold.ts by nothing. Same hotspot for
    // both, so the only thing separating them is the graph.
    const importers = Array.from({ length: 14 }, (_, i) => `src/caller${i}.ts`);
    const files = ['src/hot.ts', 'src/cold.ts', ...importers];
    const graph: ImportGraphSnapshot = {
      version: 1,
      commitSha: 'w18-25-sha',
      complete: true,
      extensions: ['.ts'],
      files,
      edges: importers.map((_, i): [number, number, string[] | null] => [i + 2, 0, ['run']]),
      aliased: [],
    };
    await writeImportGraph(db, { workspaceId, repoId, snapshot: graph });
    // Written twice: only the latest row is kept.
    await writeImportGraph(db, { workspaceId, repoId, snapshot: graph });
    const rows = await db
      .select()
      .from(read.metricSnapshots)
      .where(eq(read.metricSnapshots.metricKey, 'import_graph'));
    expect(rows.filter((r) => r.repoId === repoId)).toHaveLength(1);
    expect(await readImportGraph(db, workspaceId, repoId)).toEqual(graph);

    const hotspots = new Map([
      ['src/hot.ts', 0.5],
      ['src/cold.ts', 0.5],
    ]);
    await repriceFindings({ db, workspaceId, repoId, hotspots });
    const priced = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    const factorsOf = (id: number) =>
      priced.find((r) => r.id === id)?.riskFactors as {
        X: number;
        inputs: Record<string, unknown>;
      };
    const hot = factorsOf(hotFindingId);
    const cold = factorsOf(coldFindingId);
    expect(hot.inputs).toMatchObject({ import_fan_in: 14, exposure_why: 'imported by 14 modules' });
    expect(cold.inputs).toMatchObject({ import_fan_in: 0, exposure_why: 'nothing imports this file' });
    expect(hot.X).toBeGreaterThan(cold.X);

    // A capped snapshot: the graph says nothing, and both price as before.
    await writeImportGraph(db, { workspaceId, repoId, snapshot: { ...graph, complete: false } });
    await repriceFindings({ db, workspaceId, repoId, hotspots });
    const capped = await db.select().from(read.findings).where(eq(read.findings.repoId, repoId));
    const xs = capped
      .filter((r) => r.id === hotFindingId || r.id === coldFindingId)
      .map((r) => (r.riskFactors as { X: number; inputs: Record<string, unknown> }));
    expect(xs[0]?.X).toBe(xs[1]?.X);
    for (const f of xs) expect(f.inputs['exposure_why']).toMatch(/incomplete.*not adjusted/);
  });
});
