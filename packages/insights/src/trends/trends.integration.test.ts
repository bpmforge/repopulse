import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeMetricTrend } from './trends.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

describeIfLiveInfra('trend deltas (W3-11, FR-INSIGHTS-4)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;

  async function snap(metricKey: string, value: string, computedAt: Date) {
    await db.insert(read.metricSnapshots).values({
      workspaceId,
      repoId: null,
      metricKey,
      window: '30d',
      value,
      numerator: null,
      denominator: null,
      dims: {},
      computedAt,
    });
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w3-11-trend', name: 'w3-11-trend' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w3-11-trend' } })
      .returning();
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, workspaceId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('delta = latest − the snapshot ~one window earlier', async () => {
    // 30d window: a prior snapshot 31 days ago, a current one today.
    await snap('M5', '0.500000', new Date('2026-06-18T00:00:00Z'));
    await snap('M5', '0.800000', new Date('2026-07-19T00:00:00Z'));
    const trend = await computeMetricTrend(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M5',
      window: '30d',
    });
    expect(trend.current).toBeCloseTo(0.8, 5);
    expect(trend.previous).toBeCloseTo(0.5, 5);
    expect(trend.delta).toBeCloseTo(0.3, 5);
  });

  it('missing prior window ⇒ delta null (never a fabricated 0)', async () => {
    await snap('M9', '0.900000', new Date('2026-07-19T00:00:00Z')); // only one row
    const trend = await computeMetricTrend(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M9',
      window: '30d',
    });
    expect(trend.current).toBeCloseTo(0.9, 5);
    expect(trend.previous).toBeNull();
    expect(trend.delta).toBeNull();
  });

  it('no snapshots at all ⇒ everything null', async () => {
    const trend = await computeMetricTrend(db, {
      workspaceId,
      repoId: null,
      metricKey: 'M1',
      window: '30d',
    });
    expect(trend).toMatchObject({ current: null, previous: null, delta: null });
  });
});
