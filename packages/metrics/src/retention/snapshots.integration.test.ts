import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, read, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pruneMetricSnapshots } from './snapshots.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const NOW = Date.parse('2026-07-19T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

describeIfLiveInfra('metric_snapshots retention (W3-13, FR-METRICS-13)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let userId: number;

  async function count(): Promise<number> {
    return (
      await db
        .select()
        .from(read.metricSnapshots)
        .where(eq(read.metricSnapshots.workspaceId, workspaceId))
    ).length;
  }
  async function reportCount(): Promise<number> {
    return (await db.select().from(read.reports).where(eq(read.reports.workspaceId, workspaceId)))
      .length;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w3-13-snap-ret', name: 'w3-13-snap-ret' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w3-13-snap-ret' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w3-13-snap-user', forgeUserId: 'w3-13-snap-user', login: 'w3-13-snap-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w3-13-snap-user' } })
      .returning();
    userId = user!.id;
    // one out-of-policy (>400d), one in-policy (≤400d).
    await db.insert(read.metricSnapshots).values([
      {
        workspaceId,
        repoId: null,
        metricKey: 'M1',
        window: '30d',
        value: '1',
        numerator: null,
        denominator: null,
        dims: {},
        computedAt: daysAgo(401),
      },
      {
        workspaceId,
        repoId: null,
        metricKey: 'M1',
        window: '30d',
        value: '2',
        numerator: null,
        denominator: null,
        dims: {},
        computedAt: daysAgo(399),
      },
    ]);
    // a report that must survive the sweep.
    await db
      .insert(read.reports)
      .values({
        workspaceId,
        type: 'repo_health',
        params: {},
        status: 'ready',
        generatedBy: userId,
      });
  });

  afterAll(async () => {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, workspaceId));
    await db.delete(read.reports).where(eq(read.reports.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w3-13-snap-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('prunes rows older than 400d, keeps in-policy rows, never touches reports', async () => {
    const deleted = await pruneMetricSnapshots(db, { nowMs: NOW });
    expect(deleted).toBe(1); // the 401d row
    expect(await count()).toBe(1); // the 399d row survives (inside ≥400d policy boundary)
    expect(await reportCount()).toBe(1); // immutability
  });

  it('is idempotent — a second run deletes nothing more', async () => {
    expect(await pruneMetricSnapshots(db, { nowMs: NOW })).toBe(0);
    expect(await count()).toBe(1);
  });
});
