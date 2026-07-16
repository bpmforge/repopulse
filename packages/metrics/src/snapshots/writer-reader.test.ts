import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMetricTrend } from './reader.js';
import { writeMetricSnapshot } from './writer.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// Org-level rollup rows (repoId: null) only - avoids seeding the full
// workspace -> user -> forge_connection -> repo chain a per-repo row would
// need; the writer/reader logic is identical either way (repoId is just
// another column value), and W3-10's own acceptance is about the
// append-only row mechanics, not FK plumbing already proven elsewhere.
describeIfLiveInfra('metric snapshot writer/reader (FR-METRICS-13, W3-10 scoped)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;

  beforeAll(async () => {
    const [workspace] = await db
      .insert(core.workspaces)
      .values({ slug: 'w3-10-snapshot-test', name: 'w3-10-snapshot-test' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w3-10-snapshot-test' } })
      .returning();
    if (!workspace) throw new Error('workspace upsert returned no row');
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, workspaceId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('writes an append-only row with numerator/denominator for a ratio metric', async () => {
    await writeMetricSnapshot(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M5',
      window: '30d',
      value: 0.667,
      numerator: 6,
      denominator: 9,
    });

    const trend = await readMetricTrend(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M5',
      window: '30d',
    });
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({
      value: '0.667000',
      numerator: '6.000000',
      denominator: '9.000000',
    });
  });

  it('two nightly runs produce two rows, never an upsert (FR-METRICS-13)', async () => {
    await writeMetricSnapshot(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M1',
      window: '7d',
      value: 100,
      numerator: null,
      denominator: null,
    });
    await writeMetricSnapshot(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M1',
      window: '7d',
      value: 150,
      numerator: null,
      denominator: null,
    });

    const trend = await readMetricTrend(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M1',
      window: '7d',
    });
    expect(trend).toHaveLength(2);
    // newest first
    expect(trend[0]?.value).toBe('150.000000');
    expect(trend[1]?.value).toBe('100.000000');
  });

  it('readMetricTrend never reads across a different metricKey or window', async () => {
    await writeMetricSnapshot(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M9',
      window: '90d',
      value: 42,
      numerator: null,
      denominator: null,
    });

    const wrongMetric = await readMetricTrend(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M12',
      window: '90d',
    });
    const wrongWindow = await readMetricTrend(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M9',
      window: '7d',
    });
    expect(wrongMetric).toEqual([]);
    expect(wrongWindow).toEqual([]);
  });
});
