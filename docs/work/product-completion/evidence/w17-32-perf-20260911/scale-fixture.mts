// W17-32 scale fixture: grows the seeded warehouse to 100 repositories and
// 10,000 findings so list payloads and query counts can be MEASURED at that
// size rather than asserted. Additive over `pnpm seed`; `down` removes only
// what it added (org 'scale'). Run from the repo root:
//
//   pnpm exec tsx docs/work/product-completion/evidence/w17-32-perf-20260911/scale-fixture.mts up
//   pnpm exec tsx docs/work/product-completion/evidence/w17-32-perf-20260911/scale-fixture.mts down
import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { core, createDb, read } from '@repopulse/shared';

const TARGET_REPOS = 100;
const TARGET_FINDINGS = 10_000;
const SCALE_ORG = 'scale';
const WINDOWS = ['7d', '30d', '90d', '365d'] as const;
const METRICS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12'];
const DIMENSIONS = ['security', 'code_health', 'architecture', 'performance', 'logging'];
const STATUSES = ['open', 'open', 'open', 'confirmed', 'dismissed', 'resolved'];

// Deterministic: the same rows every run, so two measurements see one dataset.
let seed = 42;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

const db = createDb(process.env.DATABASE_URL!);
const mode = process.argv[2];

const [ws] = await db
  .select({ id: core.workspaces.id })
  .from(core.workspaces)
  .where(eq(core.workspaces.slug, 'default'));
if (!ws) throw new Error('seed workspace missing — run pnpm seed first');
const workspaceId = ws.id;

if (mode === 'down') {
  const ids = (
    await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.workspaceId, workspaceId), eq(core.repos.org, SCALE_ORG)))
  ).map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(read.findings).where(inArray(read.findings.repoId, ids));
    await db.delete(read.metricSnapshots).where(inArray(read.metricSnapshots.repoId, ids));
    await db.delete(core.repos).where(inArray(core.repos.id, ids));
  }
  // Findings the `up` step attached to the seeded repos.
  await db
    .delete(read.findings)
    .where(and(eq(read.findings.workspaceId, workspaceId), sql`${read.findings.dedupKey} like 'scale-%'`));
  await db.delete(read.analysisRuns).where(eq(read.analysisRuns.checklistVersion, 'scale-fixture'));
  console.log(`removed ${ids.length} scale repos and their rows`);
  await db.$client.end();
  process.exit(0);
}

const existing = await db
  .select({ id: core.repos.id, connectionId: core.repos.connectionId, org: core.repos.org })
  .from(core.repos)
  .where(eq(core.repos.workspaceId, workspaceId));
const connectionId = existing[0]?.connectionId;
if (connectionId === undefined) throw new Error('no seeded repo/connection');
const toAdd = TARGET_REPOS - existing.length;

const now = Date.now();
const DAY = 86_400_000;
const inserted: number[] = [];
for (let i = 0; i < toAdd; i++) {
  const [row] = await db
    .insert(core.repos)
    .values({
      workspaceId,
      connectionId,
      forgeRepoId: `scale-${i}`,
      org: SCALE_ORG,
      name: `service-${String(i).padStart(3, '0')}`,
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      syncStatus: 'live',
      backfillPct: 100,
      tier2Auto: false,
      pushedAt: new Date(now - int(0, 120) * DAY),
      lastSyncedAt: new Date(now - DAY),
    })
    .returning({ id: core.repos.id });
  inserted.push(row!.id);
}

// Two snapshot points per (repo, metric, window) — the reader only needs the
// latest; a second point keeps the "latest" query honest about ordering.
const snapshotRows: (typeof read.metricSnapshots.$inferInsert)[] = [];
for (const repoId of inserted) {
  for (const mk of METRICS) {
    const ratio = ['M2', 'M5', 'M6', 'M9'].includes(mk);
    for (const window of WINDOWS) {
      for (let p = 0; p < 2; p++) {
        snapshotRows.push({
          workspaceId,
          repoId,
          metricKey: mk,
          window,
          value: ratio ? (int(1, 10) / 10).toFixed(6) : String(int(1, 40)),
          dims: {},
          computedAt: new Date(now - (p * 7 + 1) * DAY),
        });
      }
    }
  }
}
for (let i = 0; i < snapshotRows.length; i += 500) {
  await db.insert(read.metricSnapshots).values(snapshotRows.slice(i, i + 500));
}

const [{ count }] = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(read.findings)
  .where(eq(read.findings.workspaceId, workspaceId));
const allRepoIds = [...existing.map((r) => r.id), ...inserted];
// findings_run_parent_check: exactly one of analysis_run_id / scan_run_id.
const [run] = await db
  .insert(read.analysisRuns)
  .values({
    workspaceId,
    repoId: allRepoIds[0]!,
    pullRequestId: null,
    tier: 2,
    dimension: 'performance',
    checklistVersion: 'scale-fixture',
    modelId: 'scale-fixture',
    status: 'succeeded',
    chunkCount: 1,
    promptTokens: 0,
    outputTokens: 0,
    startedAt: new Date(now - DAY),
    finishedAt: new Date(now - DAY + 1000),
  })
  .returning({ id: read.analysisRuns.id });
const findingRows: (typeof read.findings.$inferInsert)[] = [];
for (let i = 0; i < TARGET_FINDINGS - Number(count); i++) {
  const severity = int(1, 5);
  const repoId = allRepoIds[i % allRepoIds.length]!;
  const priced = rnd() < 0.8;
  const risk = priced ? Math.round(severity * 10 * (0.5 + rnd()) * 100) / 100 : null;
  findingRows.push({
    workspaceId,
    repoId,
    analysisRunId: run!.id,
    dimension: DIMENSIONS[i % DIMENSIONS.length]!,
    severity,
    confidence: int(1, 5),
    title: `Scale finding ${i}: ${DIMENSIONS[i % DIMENSIONS.length]} rule fired`,
    file: `src/module-${i % 40}/file-${i % 7}.ts`,
    lineStart: 10 + (i % 300),
    lineEnd: 12 + (i % 300),
    evidence: `Evidence block for finding ${i}. `.repeat(6),
    recommendation: `Recommendation for finding ${i}. `.repeat(4),
    tier: 1,
    dedupKey: `scale-${i}`,
    status: STATUSES[i % STATUSES.length]!,
    scannerKey: 'performance',
    ruleId: `bpm-scale-${i % 25}`,
    effectiveRisk: risk === null ? null : risk.toFixed(2),
    riskBand: risk === null ? null : risk > 30 ? 'act' : risk > 12 ? 'schedule' : 'track',
  });
}
for (let i = 0; i < findingRows.length; i += 500) {
  await db.insert(read.findings).values(findingRows.slice(i, i + 500));
}

const totals = await db.execute(sql`select
  (select count(*) from repos where workspace_id = ${workspaceId}) repos,
  (select count(*) from findings where workspace_id = ${workspaceId}) findings,
  (select count(*) from metric_snapshots where workspace_id = ${workspaceId}) snapshots`);
console.log(`scale fixture up: added ${inserted.length} repos, ${snapshotRows.length} snapshots, ${findingRows.length} findings`);
console.log(JSON.stringify(totals[0]));
await db.$client.end();
