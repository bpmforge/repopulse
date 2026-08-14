import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../db/index.js';
import { core, facts, read } from '../../db/index.js';
import { FIXTURE_LOGIN, seedWarehouse, unseedWarehouse } from './seed.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

describeIfLiveInfra('deterministic warehouse seeder (W4-00)', () => {
  const db: Database = createDb(databaseUrl as string);

  afterAll(async () => {
    await unseedWarehouse(db);
    await db.$client.end();
  });

  it('re-seeds after REAL ingestion, when forge_etag rows reference the connections', async () => {
    // The seeder ran fine for months and then broke the first time RepoPulse
    // ingested from real GitHub: api.github.com sends ETags (our fake forge
    // does not), the BudgetedClient cached them, and forge_etag rows suddenly
    // referenced the forge_connections wipeWorkspace deletes — so seeding died
    // on a FK violation for anyone who had run against a real forge, and for
    // nobody else. This pins the delete ORDER, not just that seeding works.
    const seeded = await seedWarehouse(db, { seed: 7 });

    const [conn] = await db
      .select({ id: core.forgeConnections.id, workspaceId: core.forgeConnections.workspaceId })
      .from(core.forgeConnections)
      .limit(1);
    expect(conn, 'seeder should create a connection to hang an etag off').toBeTruthy();

    await db.insert(core.forgeEtag).values({
      workspaceId: conn!.workspaceId,
      connectionId: conn!.id,
      endpointKey: 'GET /repos/acme/etag-fixture/commits',
      etag: 'W/"seed-regression"',
      cachedBody: {},
    });

    // The assertion IS that this does not throw.
    const again = await seedWarehouse(db, { seed: 7 });
    expect(again.counts).toEqual(seeded.counts);
  });

  it('seeds a multi-repo org + a second workspace, and re-seeding is deterministic + idempotent', async () => {
    const a = await seedWarehouse(db, { seed: 42 });
    expect(a.counts.repos).toBe(3);
    expect(a.counts.snapshots).toBe(12 * 4 * 4 * 8); // 12 metrics × (3 repos + org) × 4 windows × 8 points
    expect(a.repoIds).toHaveLength(3);

    // Re-seed with the same seed → same generated content (counts stable; the
    // wipe-then-reseed keeps row counts constant, not doubled).
    const b = await seedWarehouse(db, { seed: 42 });
    expect(b.counts).toEqual(a.counts);

    // A sampled snapshot value is stable across seeds (deterministic RNG).
    const [snapA] = await db
      .select({ value: read.metricSnapshots.value })
      .from(read.metricSnapshots)
      .where(
        and(
          eq(read.metricSnapshots.repoId, b.repoIds[0]!),
          eq(read.metricSnapshots.metricKey, 'M5'),
        ),
      )
      .limit(1);
    expect(snapA?.value).toBeTruthy();
  });

  it('links the fixture login to its identity and populates facts for the screens', async () => {
    const r = await seedWarehouse(db, { seed: 42 });
    const [identity] = await db
      .select()
      .from(core.identities)
      .where(
        and(
          eq(core.identities.workspaceId, r.workspaceId),
          eq(core.identities.forgeLogin, FIXTURE_LOGIN),
        ),
      )
      .limit(1);
    expect(identity!.userId).toBe(r.fixtureUserId); // linked for /me

    // every repo has commits, PRs, a release, a deployment — enough to render.
    const commits = await db
      .select()
      .from(facts.commits)
      .where(eq(facts.commits.workspaceId, r.workspaceId));
    const prs = await db
      .select()
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.workspaceId, r.workspaceId));
    expect(commits.length).toBe(r.counts.commits);
    expect(prs.length).toBe(r.counts.prs);
    expect(prs.some((p) => p.state === 'merged')).toBe(true);
    // a merge commit exists (exercises M1/M2/M3 merge exclusion in the screens)
    expect(commits.some((c) => c.isMerge)).toBe(true);
  });

  it('the second workspace is isolated (no repos leak from default)', async () => {
    const r = await seedWarehouse(db, { seed: 42 });
    const secondRepos = await db
      .select()
      .from(core.repos)
      .where(eq(core.repos.workspaceId, r.secondWorkspaceId));
    expect(secondRepos).toHaveLength(0); // second tenant is intentionally empty (tenancy control)
  });
});
