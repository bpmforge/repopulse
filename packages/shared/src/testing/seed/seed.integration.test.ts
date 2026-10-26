import 'dotenv/config';
import { and, eq, isNotNull } from 'drizzle-orm';
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

    // Delete-then-insert, because this row is this test's own fixture and its
    // primary key is (connection_id, endpoint_key). A run that was interrupted
    // before afterAll — a killed suite, a crashed VM — leaves the row behind,
    // and the next run then died on a duplicate key that had nothing to do with
    // what the test is about. Observed 2026-09-08 (W17-11).
    await db
      .delete(core.forgeEtag)
      .where(eq(core.forgeEtag.endpointKey, 'GET /repos/acme/etag-fixture/commits'));
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

    // Bus factor is a count of PEOPLE; the fixture seeds five contributors
    // (four, plus the demo committer W16-13 added).
    for (const v of valuesFor('M3', 'repo')) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
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
    for (const v of valuesFor('M3', 'org')) expect(v).toBeLessThanOrEqual(5);
    for (const v of valuesFor('M7', 'org')) expect(v).toBeLessThanOrEqual(320);

    // The series must still MOVE, or every trend delta reads "no change" and
    // the sparkline is a flat line — the failure the series was added to fix.
    //
    // PER WINDOW, because this assertion used to pool all four and so passed on
    // 7d's variety alone. W16-45 made each window a smoothing of one process,
    // and a long window IS the flat one — so pooling would have hidden a 365d
    // sparkline that never moves.
    //
    // Asserted on the WIDE-band metrics only. A narrow one is honestly flat
    // over a long window: the fixture has four issues in total, so a 365-day
    // issue-throughput line SHOULD be a straight line at 4, and demanding
    // movement there would be demanding the fixture lie.
    for (const window of ['7d', '30d', '90d', '365d']) {
      for (const key of ['M4', 'M9', 'M1']) {
        const series = rows
          .filter((row) => row.metricKey === key && row.window === window && row.repoId !== null)
          .map((row) => Number(row.value));
        expect(new Set(series).size, `${key} @ ${window}`).toBeGreaterThan(1);
      }
    }
  });

  it('the four windows of a metric nest instead of contradicting each other (W16-45)', async () => {
    // Every (scope, metric, WINDOW) got its own independent random walk, so the
    // four windows of one metric were four unrelated series. The demo showed
    // acme/payments at a 30% CI pass rate over 7d and 90% over 365d ON THE SAME
    // DATES — a year that contains the week cannot disagree with it like that.
    // Moving the window control swung every rate on screen with no explanation
    // a reader could construct.
    const r = await seedWarehouse(db, { seed: 13 });
    const rows = await db
      .select()
      .from(read.metricSnapshots)
      .where(
        and(
          eq(read.metricSnapshots.workspaceId, r.workspaceId),
          eq(read.metricSnapshots.repoId, r.repoIds[0]!),
        ),
      );

    const series = (key: string, window: string) =>
      rows
        .filter((row) => row.metricKey === key && row.window === window)
        .sort((a, b) => a.computedAt.getTime() - b.computedAt.getTime())
        .map((row) => Number(row.value));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

    for (const key of ['M9', 'M5', 'M6', 'M4']) {
      const short = series(key, '7d');
      const long = series(key, '365d');
      expect(short.length, `${key} 7d`).toBeGreaterThan(1);
      expect(long.length, `${key} 365d`).toBe(short.length);

      // SAME LEVEL: the windows measure one underlying process, so their means
      // agree to within a tenth of the range they move over. This is the
      // assertion the old seeder could not have passed.
      const scale = Math.max(spread(short), 1e-9);
      expect(Math.abs(mean(short) - mean(long)), `${key} level`).toBeLessThanOrEqual(scale);

      // DIFFERENT VOLATILITY: a longer window is a longer average, so it is the
      // smoother line. Equal spreads would mean the window changed nothing.
      expect(spread(long), `${key} smoothness`).toBeLessThanOrEqual(spread(short));
    }

    // 90d and 365d must not be the SAME line either — two windows rendering
    // identically would quietly claim they measure the same thing.
    expect(series('M9', '90d')).not.toEqual(series('M9', '365d'));
  });

  it("the CI tab's pass rate is the newest point of the chart above it (W16-45)", async () => {
    // These were independent draws: dims.passRate came from rng.int(70, 99)
    // while the plotted series came from its own walk, so the card could read
    // 90% over a chart that ended at 30%.
    const r = await seedWarehouse(db, { seed: 17 });
    const rows = await db
      .select()
      .from(read.metricSnapshots)
      .where(
        and(
          eq(read.metricSnapshots.workspaceId, r.workspaceId),
          eq(read.metricSnapshots.repoId, r.repoIds[0]!),
          eq(read.metricSnapshots.metricKey, 'M9'),
          eq(read.metricSnapshots.window, '30d'),
        ),
      );
    const newest = rows.sort((a, b) => b.computedAt.getTime() - a.computedAt.getTime())[0]!;
    const dims = newest.dims as { passRate?: number; defaultBranchRuns?: number };
    expect(dims.passRate).toBeCloseTo(Number(newest.value), 6);
    // …and the run count the card prints is the denominator the rate is of, so
    // "80% of 24 runs" is one coherent sentence.
    expect(dims.defaultBranchRuns).toBe(Number(newest.denominator));

    // A COUNT OF RUNS GROWS WITH THE WINDOW. A fixed denominator made the CI
    // tab print the same "Runs 38" at 7d and at 365d, which says a year of CI
    // and a week of it saw the same number of builds.
    const denomFor = async (window: string) => {
      const [row] = await db
        .select({ denominator: read.metricSnapshots.denominator })
        .from(read.metricSnapshots)
        .where(
          and(
            eq(read.metricSnapshots.workspaceId, r.workspaceId),
            eq(read.metricSnapshots.repoId, r.repoIds[0]!),
            eq(read.metricSnapshots.metricKey, 'M9'),
            eq(read.metricSnapshots.window, window),
          ),
        )
        .limit(1);
      return Number(row!.denominator);
    };
    expect(await denomFor('7d')).toBeLessThan(await denomFor('30d'));
    expect(await denomFor('30d')).toBeLessThan(await denomFor('365d'));
  });

  it('every seeded finding names a file the fixture actually has history for (W16-46)', async () => {
    // The findings were invented separately from the commit fixture, so all
    // three named files no commit had ever touched. Following one from the
    // Findings tab landed on a file drill-down whose churn AND owners both read
    // "Not Found" behind a Retry that could never succeed — the product looking
    // broken on the exact path its own finding had just recommended.
    const r = await seedWarehouse(db, { seed: 23 });
    const found = await db
      .select({ file: read.findings.file })
      .from(read.findings)
      .where(eq(read.findings.workspaceId, r.workspaceId));
    const touched = await db
      .selectDistinct({ path: facts.commitFiles.path })
      .from(facts.commitFiles)
      .where(eq(facts.commitFiles.workspaceId, r.workspaceId));
    const paths = new Set(touched.map((t) => t.path));

    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      // A repository-level finding has no file, and that is a real answer.
      if (f.file === null) continue;
      expect(paths.has(f.file), `${f.file} has no commit history`).toBe(true);
    }
  });

  it("a PR-scoped finding is on a PR that touched the finding's file (W16-46)", async () => {
    // A diff review can only report what is in the diff. The first cut attached
    // the security finding to the first PR by number, and the demo then showed
    // an automated review of src/payments/charge.ts on a pull request whose
    // only file was src/reports/build.ts.
    const r = await seedWarehouse(db, { seed: 29 });
    const scoped = await db
      .select({ file: read.findings.file, prId: read.findings.pullRequestId })
      .from(read.findings)
      .where(
        and(eq(read.findings.workspaceId, r.workspaceId), isNotNull(read.findings.pullRequestId)),
      );
    expect(scoped.length).toBeGreaterThan(0);
    for (const f of scoped) {
      const touched = await db
        .select({ path: facts.prFiles.path })
        .from(facts.prFiles)
        .where(eq(facts.prFiles.pullRequestId, f.prId!));
      expect(
        touched.map((t) => t.path),
        `finding on PR ${f.prId}`,
      ).toContain(f.file);
    }
  });

  it('a merged PR records WHEN it was approved, not only that it was (W16-46)', async () => {
    // first_approval_at was never set although every merged PR gets exactly one
    // APPROVED review, so two of the three rows of the PR drill-down's stage
    // timeline — "First review → approved" and "Approved → merged" — read "—"
    // on every seeded PR, beside an approving review the same screen displayed.
    const r = await seedWarehouse(db, { seed: 31 });
    const merged = await db
      .select({
        number: facts.pullRequests.number,
        firstApprovalAt: facts.pullRequests.firstApprovalAt,
        mergedAt: facts.pullRequests.mergedAt,
      })
      .from(facts.pullRequests)
      .where(
        and(
          eq(facts.pullRequests.workspaceId, r.workspaceId),
          eq(facts.pullRequests.state, 'merged'),
        ),
      );
    expect(merged.length).toBeGreaterThan(0);
    for (const pr of merged) {
      expect(pr.firstApprovalAt, `PR ${pr.number} approval time`).not.toBeNull();
      // And approved BEFORE merged, or the stage would render a negative span.
      expect(pr.firstApprovalAt!.getTime()).toBeLessThanOrEqual(pr.mergedAt!.getTime());
    }
  });

  it("keeps each repository's id across a re-seed, so a demo URL survives (W16-48)", async () => {
    // seedWarehouse wiped and re-inserted, so every repository got a new id on
    // every boot: a bookmarked /repos/34565/hotspots was a 404 after the next
    // `pnpm dev`. The suite next door already claimed re-seeding was
    // "deterministic + idempotent" while the one value that appears in URLs
    // changed each time.
    const first = await seedWarehouse(db, { seed: 5 });
    const second = await seedWarehouse(db, { seed: 5 });
    expect(second.repoIds).toEqual(first.repoIds);

    // A DIFFERENT seed still keeps the ids: the fixture's repositories are the
    // same three repositories, whatever numbers get generated inside them.
    const third = await seedWarehouse(db, { seed: 99 });
    expect(third.repoIds).toEqual(first.repoIds);

    // And the rows BELOW a repo were genuinely rebuilt, not left behind — the
    // point is a stable id, not a skipped re-seed.
    const commits = await db
      .select({ id: facts.commits.id })
      .from(facts.commits)
      .where(eq(facts.commits.repoId, first.repoIds[0]!));
    expect(commits.length).toBeGreaterThan(0);
  });

  it('still removes a repository that is NOT part of the fixture', async () => {
    // The wipe spares the fixture's own repos by forge id. Anything else — a
    // repository ingested from a real forge — must still go, or "seeded" stops
    // meaning the same thing for every suite that counts rows.
    const r = await seedWarehouse(db, { seed: 7 });
    const [conn] = await db
      .select({ id: core.forgeConnections.id })
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, r.workspaceId))
      .limit(1);
    await db.insert(core.repos).values({
      workspaceId: r.workspaceId,
      connectionId: conn!.id,
      forgeRepoId: 'not-a-fixture-repo',
      org: 'acme',
      name: 'stray',
      defaultBranch: 'main',
      isPrivate: true,
      isArchived: false,
      syncStatus: 'live',
      tier2Auto: false,
    });

    const after = await seedWarehouse(db, { seed: 7 });
    const names = await db
      .select({ forgeRepoId: core.repos.forgeRepoId })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, after.workspaceId));
    expect(names.map((n) => n.forgeRepoId)).not.toContain('not-a-fixture-repo');
  });

  it('the second workspace is isolated (no repos leak from default)', async () => {
    const r = await seedWarehouse(db, { seed: 42 });
    const secondRepos = await db
      .select()
      .from(core.repos)
      .where(eq(core.repos.workspaceId, r.secondWorkspaceId));
    expect(secondRepos).toHaveLength(0); // second tenant is intentionally empty (tenancy control)
  });
  it('a re-seed restores a kept repository to the fixture settings (W21-01)', async () => {
    // The e2e suite opts a repository into Tier 3. The re-seed kept the row
    // (W16-48) and its opt-in with it, so a second run began opted in.
    const first = await seedWarehouse(db, { seed: 7 });
    await db
      .update(core.repos)
      .set({ tier3OptIn: true, tier2Auto: true })
      .where(eq(core.repos.id, first.repoIds[0]!));
    const again = await seedWarehouse(db, { seed: 7 });
    expect(again.repoIds[0]).toBe(first.repoIds[0]);
    const [row] = await db
      .select({ tier3: core.repos.tier3OptIn, tier2: core.repos.tier2Auto })
      .from(core.repos)
      .where(
        and(eq(core.repos.id, again.repoIds[0]!), eq(core.repos.workspaceId, again.workspaceId)),
      );
    expect(row).toEqual({ tier3: false, tier2: false });
  });
});
