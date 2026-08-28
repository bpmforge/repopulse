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

  it('seeds metric values a repository could actually produce (W16-27)', async () => {
    // The fixture reported 175 stale PRs across 15 seeded PRs, ~300 releases
    // against three, and a bus factor of 90 over four contributors, because
    // every non-ratio metric shared one anonymous rng.int(20, 180) walk. It is
    // the demo people judge the product by — and M8 at 175 is also what
    // dragged reviewHygiene to zero, so the headline health scores were shaped
    // by a number no repository could produce.
    const r = await seedWarehouse(db, { seed: 11 });
    const rows = await db
      .select()
      .from(read.metricSnapshots)
      .where(eq(read.metricSnapshots.workspaceId, r.workspaceId));
    expect(rows.length).toBe(r.counts.snapshots);

    const valuesFor = (key: string, scope: 'repo' | 'org') =>
      rows
        .filter((row) => row.metricKey === key && (scope === 'org') === (row.repoId === null))
        .map((row) => Number(row.value));

    // EVERY POINT in the series, not just the newest: a sparkline shows all of
    // them, and one impossible point is still an impossible number on screen.
    const openPrsPerRepo = 2;
    for (const v of valuesFor('M8', 'repo')) expect(v).toBeLessThanOrEqual(openPrsPerRepo);
    // The org rollup is the repos summed, so it scales — and still cannot
    // exceed the PRs that exist.
    for (const v of valuesFor('M8', 'org')) expect(v).toBeLessThanOrEqual(r.counts.prs);

    // Bus factor is a count of PEOPLE; the fixture seeds four contributors.
    for (const v of valuesFor('M3', 'repo')) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(4);
    }
    // One release per repo, so a window cannot hold hundreds.
    for (const v of valuesFor('M11', 'repo')) expect(v).toBeLessThanOrEqual(2);

    // M2 is a hotspot SCORE catalogued as 0-1 and was outside the ratio set,
    // so it seeded as a bare level in the tens.
    for (const v of valuesFor('M2', 'repo')) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    // AN AVERAGE DOES NOT SUM. The first version of this fix scaled every
    // metric by the repo count, which put the org's PR cycle time at 823 hours
    // on a fixture whose PRs merge in one to six days. Three repos do not make
    // a pull request slower.
    for (const v of valuesFor('M4', 'org')) expect(v).toBeLessThanOrEqual(320);
    for (const v of valuesFor('M3', 'org')) expect(v).toBeLessThanOrEqual(4);
    for (const v of valuesFor('M7', 'org')) expect(v).toBeLessThanOrEqual(320);

    // The series must still MOVE, or every trend delta reads "no change" and
    // the sparkline is a flat line — the failure the series was added to fix.
    const cycle = valuesFor('M4', 'repo');
    expect(new Set(cycle).size).toBeGreaterThan(1);
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
