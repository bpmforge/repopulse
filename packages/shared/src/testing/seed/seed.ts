import { and, eq, inArray, ne, notInArray, or } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { core, facts, plans, read, security } from '../../db/index.js';
import { makeRng, type Rng } from './prng.js';

// Deterministic warehouse seeder (W4-00) — one multi-repo org + a second
// workspace, identities incl. the fixture login, facts and metric_snapshot rows
// sufficient for every UX_SPEC §4 screen. Seeded RNG so e2e suites assert on
// exact values. Idempotent: wipes its own workspaces first, then reseeds.

export const SEED_DEFAULT_SLUG = 'default';
export const SEED_SECOND_SLUG = 'seed-second-tenant';
export const FIXTURE_LOGIN = 'fixture-dev';
/**
 * The DEMO account's committer identity (W16-13).
 *
 * A second one, not a share of the fixture's. `users.forge_user_id` is UNIQUE,
 * so the demo's local account cannot claim FIXTURE_LOGIN without taking it
 * away from the mocked-OAuth path — and the README advertises BOTH sign-in
 * doors, so whichever one lost it would land on an empty My Focus. Two
 * identities is the only shape where both doors open onto the same populated
 * screen.
 *
 * It is a full contributor, not a decoration: it authors commits, opens PRs
 * and reviews other people's, because "My Focus" being present but empty is
 * the state this exists to remove.
 */
export const DEMO_LOGIN = 'demo-dev';
const CONTRIBUTORS = ['alice', 'bob', 'carol', FIXTURE_LOGIN, DEMO_LOGIN] as const;
const BOT = 'renovate[bot]';
// Exported so specs can target a SEEDED repo by name instead of "whichever
// tile renders first" — the ingest specs legitimately add repos to this same
// workspace, so position is not identity.
export const SEED_REPO_NAMES = ['payments', 'web-app', 'infra'] as const;
/** The fixture's forge ids — the natural key that keeps a repo's row id stable. */
const SEED_FORGE_REPO_IDS = SEED_REPO_NAMES.map((n) => `seed-${n}`);
/** Identifies the fixture's own connection, which survives a re-seed with them. */
const SEED_CREDENTIAL_FINGERPRINT = 'seed:fp';
const REPO_NAMES = SEED_REPO_NAMES;
const DAY = 24 * 60 * 60 * 1000;

/** The fixture's activity spans this many days, ending at the anchor. */
const SPAN_DAYS = 40;
/** Weekly snapshot points per (scope × metric × window) — >=2 so a sparkline renders. */
const SERIES_POINTS = 8;
/**
 * The fixture's source files (W16-46).
 *
 * Two things this list has to be. Named like a real service rather than
 * `mod0.ts`..`mod3.ts`, because a hotspot map reading "payments/charge.ts" is
 * the demo doing its job and one reading "mod2.ts" is not. And a SUPERSET of
 * the paths the seeded findings point at — those three were invented
 * separately, so every finding named a file the commit fixture had never heard
 * of, and following one from the Findings tab landed on a file drill-down whose
 * churn and owners both read "Not Found" behind a Retry button that could never
 * succeed.
 *
 * Anything added to `findingSeeds` below belongs here too.
 */
const FIXTURE_FILES = [
  'src/payments/charge.ts',
  'src/reports/build.ts',
  'src/sync/webhook.ts',
  'src/api/routes.ts',
] as const;

/** Every window preset the UI offers; the API filters snapshots by this exact string. */
const WINDOWS = ['7d', '30d', '90d', '365d'] as const;

/**
 * Anchor the fixture RELATIVE to run time, quantised to UTC midnight.
 *
 * Absolute dates were the original bug: the fixture was pinned to June 2026, so
 * from July onwards the default 30d window contained no fixture data at all and
 * every screen e2e silently degraded to asserting empty states. Quantising to
 * midnight keeps determinism where it matters — two seeds on the same UTC day
 * produce identical timestamps — while `opts.now` lets a test pin it outright.
 */
function anchorFor(now: number): number {
  const midnightUtc = Math.floor(now / DAY) * DAY;
  return midnightUtc - SPAN_DAYS * DAY;
}

/**
 * M9's dims in the shape snapshots/compute.ts writes them (W4-15).
 *
 * The seeder does not run the metric engine, so these are fabricated like every
 * other seeded value — but the SHAPE is the contract the CI tab reads, and
 * getting it wrong here would make the screen's tests pass against a payload
 * production never produces. Null is used where the engine uses null (a
 * workflow never rerun has no flakiness ratio), because "no CI" and "CI that
 * never passes" must stay distinguishable on screen.
 */
function m9Dims(rng: Rng, passRate: number, defaultBranchRuns: number): Record<string, unknown> {
  const flaky = [
    { workflowName: 'ci', rerunGroups: rng.int(3, 8), flippedGroups: rng.int(1, 3) },
    { workflowName: 'e2e', rerunGroups: rng.int(1, 4), flippedGroups: rng.int(0, 1) },
  ].map((f) => ({
    ...f,
    flakinessRatio: f.rerunGroups === 0 ? null : f.flippedGroups / f.rerunGroups,
  }));
  flaky.sort((a, b) => (b.flakinessRatio ?? -1) - (a.flakinessRatio ?? -1));

  const medianMs = rng.int(2, 12) * 60_000;
  return {
    // TAKEN FROM THE ROW, not drawn again (W16-45). These were independent
    // draws, so the CI tab's pass rate and the newest point of the pass-rate
    // chart directly above it were two unrelated numbers for one measurement —
    // and the card could read 90% over a series that ended at 30%.
    passRate,
    // PR runs are a different population than default-branch runs, so a
    // different rate is correct; anchored to the same level rather than drawn
    // from thin air, because a repo whose main branch is green rarely has PRs
    // failing three times as often.
    prPassRate: Math.min(1, Math.max(0, passRate - rng.int(0, 15) / 100)),
    defaultBranchRuns,
    prRuns: defaultBranchRuns + rng.int(2, 20),
    duration: { medianMs, p90Ms: medianMs + rng.int(1, 8) * 60_000 },
    flakiness: flaky,
    flakinessWorkflows: flaky.length,
    topFlakiness: flaky[0]?.flakinessRatio ?? null,
  };
}

export interface SeedResult {
  workspaceId: number;
  secondWorkspaceId: number;
  fixtureUserId: number;
  fixtureIdentityId: number;
  /** The DEMO account's committer identity (W16-13). */
  demoIdentityId: number;
  repoIds: number[];
  counts: { repos: number; commits: number; prs: number; snapshots: number };
}

// Delete order is FK order, and every table referencing repos or
// forge_connections must appear BEFORE them. This is not hypothetical
// bookkeeping: the seeder ran fine for months and then failed the moment
// RepoPulse first ingested from real GitHub, because api.github.com sends
// ETags (our fake forge does not), the BudgetedClient cached them, and 351
// forge_etag rows suddenly referenced the connections this function deletes.
//
// Anything writing a new repo- or connection-scoped table has to be added
// here, or reseeding breaks only for whoever has exercised that code path —
// the worst kind of failure to debug, because it reproduces for one person.
/**
 * Empty a workspace.
 *
 * `keepFixtureRepos` is the difference between RE-SEEDING and UNSEEDING
 * (W16-48). A re-seed keeps the fixture's own repository rows so their ids —
 * the numbers that appear in every URL — survive a restart. An unseed is the
 * inverse of seeding and must leave nothing behind, or the next caller inherits
 * three repositories it did not create.
 */
async function wipeWorkspace(
  db: Database,
  workspaceId: number,
  { keepFixtureRepos = false }: { keepFixtureRepos?: boolean } = {},
): Promise<void> {
  // W21-01: every other table that references repos (or a finding) goes
  // first. These five were missing, and once a run had INGESTED a repository —
  // the e2e ingest spec does, and the snapshot job then scores its files — the
  // next seed failed on file_hotspot_scores' foreign key: a second `pnpm e2e`
  // or a DEMO_MODE boot on the same database could not start.
  await db.delete(read.aiTriageVerdicts).where(eq(read.aiTriageVerdicts.workspaceId, workspaceId));
  await db
    .delete(read.aiFindingProvenance)
    .where(eq(read.aiFindingProvenance.workspaceId, workspaceId));
  await db.delete(read.verifiedPatches).where(eq(read.verifiedPatches.workspaceId, workspaceId));
  await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, workspaceId));
  await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, workspaceId));
  await db
    .delete(read.fileHotspotScores)
    .where(eq(read.fileHotspotScores.workspaceId, workspaceId));
  await db
    .delete(facts.prReviewRequests)
    .where(eq(facts.prReviewRequests.workspaceId, workspaceId));
  // Analysis/audit rows reference repos.
  await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
  await db.delete(read.findings).where(eq(read.findings.workspaceId, workspaceId));
  await db.delete(read.analysisRuns).where(eq(read.analysisRuns.workspaceId, workspaceId));
  await db.delete(read.egressAudit).where(eq(read.egressAudit.workspaceId, workspaceId));
  await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, workspaceId));
  await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, workspaceId));
  await db
    .delete(facts.prReviewComments)
    .where(eq(facts.prReviewComments.workspaceId, workspaceId));
  await db.delete(facts.prReviews).where(eq(facts.prReviews.workspaceId, workspaceId));
  await db.delete(facts.prFiles).where(eq(facts.prFiles.workspaceId, workspaceId));
  await db.delete(facts.checkRuns).where(eq(facts.checkRuns.workspaceId, workspaceId));
  await db.delete(facts.commits).where(eq(facts.commits.workspaceId, workspaceId));
  await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
  await db.delete(facts.issues).where(eq(facts.issues.workspaceId, workspaceId));
  await db.delete(facts.releases).where(eq(facts.releases.workspaceId, workspaceId));
  await db.delete(facts.deployments).where(eq(facts.deployments.workspaceId, workspaceId));
  await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
  await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
  // THE FIXTURE'S OWN REPOS SURVIVE THE WIPE (W16-48), so their ids do too.
  //
  // Deleting and re-inserting them gave every repository a new id on every
  // boot, so a bookmarked demo URL — /repos/34565/hotspots — was a 404 after
  // the next `pnpm dev`, and this seeder's own test claimed re-seeding was
  // "deterministic + idempotent" while the one value that appears in URLs
  // changed each time. Everything BELOW a repo is still deleted and rebuilt;
  // only the row that owns the id is kept and updated in place.
  //
  // A repo's unique key is (workspace, connection, forge_repo_id), so keeping
  // the repo means keeping ITS connection — and exactly one of them, chosen
  // here rather than by a `limit 1` further down. Two connections in the
  // workspace and an arbitrary pick is how the first cut produced a second set
  // of repositories with new ids, which is the bug wearing a disguise.
  //
  // It cannot be identified by fingerprint either: DEMO MODE replaces the
  // seeded connection with its own, pointed at the fake forge, and repoints the
  // repos at it.
  const keepConnection = keepFixtureRepos
    ? ((
        await db
          .select({ id: core.repos.connectionId })
          .from(core.repos)
          .where(
            and(
              eq(core.repos.workspaceId, workspaceId),
              inArray(core.repos.forgeRepoId, SEED_FORGE_REPO_IDS),
            ),
          )
          .orderBy(core.repos.id)
          .limit(1)
      )[0]?.id ?? null)
    : null;

  // Anything NOT in the fixture goes, and so does a fixture repo hanging off a
  // connection we are about to remove — leaving one would fail the connection
  // delete below for a row nothing wanted to keep.
  await db.delete(core.repos).where(
    and(
      eq(core.repos.workspaceId, workspaceId),
      keepConnection === null
        ? undefined
        : // Keep exactly (a fixture forge id) AND (the kept connection);
          // delete the complement of that pair.
          or(
            notInArray(core.repos.forgeRepoId, SEED_FORGE_REPO_IDS),
            ne(core.repos.connectionId, keepConnection),
          ),
    ),
  );
  // Both reference forge_connections and must go before it. forge_etag is the
  // one that actually broke: it is written only when a forge returns an ETag,
  // so it stayed empty until the first real-GitHub run.
  await db.delete(core.forgeEtag).where(eq(core.forgeEtag.workspaceId, workspaceId));
  await db.delete(core.webhookDelivery).where(eq(core.webhookDelivery.workspaceId, workspaceId));
  await db
    .delete(core.forgeConnections)
    .where(
      and(
        eq(core.forgeConnections.workspaceId, workspaceId),
        keepConnection === null ? undefined : ne(core.forgeConnections.id, keepConnection),
      ),
    );
  // Saved views (W5-02). Workspace-scoped like everything above, and missed
  // until something finally created one: saved_views has an FK to users, so a
  // leftover view makes unseedWarehouse's user delete fail with a constraint
  // error from a table the caller never mentioned.
  // SBOMs (W8-02).
  await db.delete(security.sboms).where(eq(security.sboms.workspaceId, workspaceId));
  // Scanner config and runs (W8-01).
  await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, workspaceId));
  await db
    .delete(security.repoScannerConfig)
    .where(eq(security.repoScannerConfig.workspaceId, workspaceId));
  // File intents (W6-07).
  await db.delete(plans.fileIntents).where(eq(plans.fileIntents.workspaceId, workspaceId));
  // Agreements (W5-08).
  await db.delete(plans.agreements).where(eq(plans.agreements.workspaceId, workspaceId));
  // Plans (W5-06). Children first: plan_item_events -> plan_items ->
  // improvement_plans, since each FKs the one before it.
  await db.delete(plans.planItemEvents).where(eq(plans.planItemEvents.workspaceId, workspaceId));
  await db.delete(plans.planItems).where(eq(plans.planItems.workspaceId, workspaceId));
  await db
    .delete(plans.improvementPlans)
    .where(eq(plans.improvementPlans.workspaceId, workspaceId));
  // Reports (W5-04), for the same reason as saved views directly below: the
  // row FKs to users, so a leftover report makes unseedWarehouse's user delete
  // fail with a constraint error naming a table the caller never mentioned.
  // Second time this exact gap has surfaced — every future workspace-scoped
  // table needs a line here.
  await db.delete(read.reports).where(eq(read.reports.workspaceId, workspaceId));
  await db.delete(read.savedViews).where(eq(read.savedViews.workspaceId, workspaceId));
  // Connections were deleted HERE as well as above. The guarded delete near the
  // repos is the one that survives: this unconditional copy removed the very
  // connection the kept repositories point at, so it threw the FK error the
  // whole change exists to avoid — and it did so silently at first, because the
  // guarded delete above matched nothing and looked innocent.
}

export async function seedWarehouse(
  db: Database,
  opts: { seed?: number; now?: number } = {},
): Promise<SeedResult> {
  const rng = makeRng(opts.seed ?? 42);
  // Day 0 of the fixture. Everything below is an offset from here, so the whole
  // warehouse slides forward with the calendar (W4-13).
  const BASE = anchorFor(opts.now ?? Date.now());

  // --- workspaces ---
  const [ws] = await db
    .insert(core.workspaces)
    .values({ slug: SEED_DEFAULT_SLUG, name: 'Default' })
    .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
    .returning();
  const [ws2] = await db
    .insert(core.workspaces)
    .values({ slug: SEED_SECOND_SLUG, name: 'Second Tenant' })
    .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Second Tenant' } })
    .returning();
  const workspaceId = ws!.id;
  const secondWorkspaceId = ws2!.id;
  await wipeWorkspace(db, workspaceId, { keepFixtureRepos: true });
  await wipeWorkspace(db, secondWorkspaceId, { keepFixtureRepos: true });

  // --- users + membership (fixture is admin) ---
  // W4-10: the fixture user carries a PERSONA. A null persona is what opens the
  // first-login picker (UX_SPEC §6), and a modal over every seeded screen would
  // break every e2e for a reason having nothing to do with what they assert.
  // The picker's own spec clears the column first, so it still tests the real
  // first-login state rather than a mock of it.
  const [fixtureUser] = await db
    .insert(core.users)
    .values({
      authProvider: 'github',
      authSubject: FIXTURE_LOGIN,
      forgeUserId: FIXTURE_LOGIN,
      login: FIXTURE_LOGIN,
      persona: 'lead',
    })
    .onConflictDoUpdate({
      target: core.users.forgeUserId,
      set: { login: FIXTURE_LOGIN, persona: 'lead' },
    })
    .returning();
  await db
    .insert(core.workspaceMembers)
    .values({ workspaceId, userId: fixtureUser!.id, role: 'admin' })
    .onConflictDoUpdate({
      target: [core.workspaceMembers.workspaceId, core.workspaceMembers.userId],
      set: { role: 'admin' },
    });

  // REUSE whatever connection the surviving repos are attached to (W16-48).
  // Not the one with the seed fingerprint: demo mode swaps that row for its
  // own, and re-seeding onto a fresh connection would change the repos' unique
  // key and hand them new ids — the exact thing this is here to prevent.
  const [existingConn] = await db
    .select({ id: core.forgeConnections.id })
    .from(core.forgeConnections)
    .where(eq(core.forgeConnections.workspaceId, workspaceId))
    .limit(1);

  const [insertedConn] = existingConn
    ? [undefined]
    : await db
        .insert(core.forgeConnections)
        .values({
          workspaceId,
          provider: 'github',
          authKind: 'pat',
          credentialCiphertext: Buffer.from('seed'),
          credentialIv: Buffer.from('iv-seed-1234567'),
          keyVersion: 1,
          credentialFingerprint: SEED_CREDENTIAL_FINGERPRINT,
          status: 'active',
          createdBy: fixtureUser!.id,
        })
        .returning();
  const conn = existingConn ?? insertedConn;

  // --- identities (incl. the fixture login + a bot) ---
  const identityIds = new Map<string, number>();
  for (const login of [...CONTRIBUTORS, BOT]) {
    const [id] = await db
      .insert(core.identities)
      .values({
        workspaceId,
        provider: 'github',
        forgeLogin: login,
        // The two LINKABLE logins carry their own name as the forge user id,
        // because that is what an OAuth callback and demo.ts each look up.
        forgeUserId: login === FIXTURE_LOGIN || login === DEMO_LOGIN ? login : `id-${login}`,
        displayName: login,
        isBot: login === BOT,
        ...(login === FIXTURE_LOGIN ? { userId: fixtureUser!.id } : {}),
      })
      .returning();
    identityIds.set(login, id!.id);
  }
  const humanIds = CONTRIBUTORS.map((l) => identityIds.get(l)!);

  // --- repos + facts ---
  const repoIds: number[] = [];
  let commitCount = 0;
  let prCount = 0;
  for (let ri = 0; ri < REPO_NAMES.length; ri++) {
    const name = REPO_NAMES[ri]!;
    // UPSERT on the natural key (W16-48): the row that owns the id is updated
    // in place rather than replaced, so /repos/<id>/... survives a restart.
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: `seed-${name}`,
        org: 'acme',
        name,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
        pushedAt: new Date(BASE + 40 * DAY - rng.int(0, 5) * DAY),
      })
      .onConflictDoUpdate({
        target: [core.repos.workspaceId, core.repos.connectionId, core.repos.forgeRepoId],
        set: {
          org: 'acme',
          name,
          defaultBranch: 'main',
          syncStatus: 'live',
          // W21-01: the kept row is reset to the fixture's settings too. The
          // e2e suite turns Tier-3 on for a repository, so a second run on the
          // same database began with it already on and the opt-in test could
          // not opt in.
          tier2Auto: false,
          tier3OptIn: false,
          pushedAt: new Date(BASE + 40 * DAY - rng.int(0, 5) * DAY),
        },
      })
      .returning();
    const repoId = repo!.id;
    repoIds.push(repoId);

    // commits + commit_files (one merge commit)
    for (let c = 0; c < 8; c++) {
      const authorId = rng.pick(humanIds);
      const at = new Date(BASE + (c * 5 + rng.int(0, 2)) * DAY);
      const isMerge = c === 7;
      const [commit] = await db
        .insert(facts.commits)
        .values({
          workspaceId,
          repoId,
          sha: `${name}-c${c}`,
          authorIdentityId: authorId,
          committerIdentityId: authorId,
          authoredAt: at,
          committedAt: at,
          messageHead: isMerge ? 'Merge branch' : `change ${c}`,
          // W18-20: two agent-co-authored commits per repo, so the AI-code
          // governance tile has both cohorts to show. Fixed by index, NOT drawn
          // from rng: an extra draw would shift every value seeded after it.
          trailers: c === 1 || c === 4 ? ['Co-authored-by: Claude <noreply@anthropic.com>'] : [],
          isRevertHeuristic: false,
          isMerge,
        })
        .returning();
      commitCount++;
      const files = rng.int(1, 3);
      for (let f = 0; f < files; f++) {
        await db
          .insert(facts.commitFiles)
          .values({
            workspaceId,
            repoId,
            commitId: commit!.id,
            path: FIXTURE_FILES[(ri + f) % FIXTURE_FILES.length]!,
            additions: rng.int(5, 80),
            deletions: rng.int(0, 30),
            status: 'modified',
          })
          .onConflictDoNothing();
      }
    }

    // PRs (5): 3 merged, 2 open; merged ones get a review + checks
    for (let p = 1; p <= 5; p++) {
      const merged = p <= 3;
      const authorId = rng.pick(humanIds);
      const created = new Date(BASE + p * 7 * DAY);
      const firstReview = merged
        ? new Date(created.getTime() + rng.int(2, 40) * 3600 * 1000)
        : null;
      // MERGED AFTER IT WAS REVIEWED. This was `created + 1..6 days` while the
      // review was `created + 2..40 hours`, so a 40-hour review on a PR merged
      // after one day produced a pull request approved AFTER it was merged
      // (W16-46) — which the stage timeline would draw as a negative span.
      // Derived from the review instead, so the ordering holds by construction
      // rather than by the two ranges happening not to cross.
      const mergedAt = merged
        ? new Date(firstReview!.getTime() + rng.int(2, 48) * 3600 * 1000)
        : null;
      const headSha = `${name}-pr${p}-head`;
      const [pr] = await db
        .insert(facts.pullRequests)
        .values({
          workspaceId,
          repoId,
          number: p,
          forgePrId: `${name}-PR${p}`,
          title: `feature ${p}`,
          authorIdentityId: authorId,
          state: merged ? 'merged' : 'open',
          isDraft: false,
          isBot: false,
          createdAt: created,
          updatedAt: mergedAt ?? created,
          closedAt: mergedAt,
          mergedAt,
          baseRef: 'main',
          headSha,
          // W18-20: agent branch prefixes on two of the five (fixed, not rng).
          headRef:
            p === 2 ? `claude/feature-${p}` : p === 4 ? `copilot/feature-${p}` : `feature/${p}`,
          additions: rng.int(5, 300),
          deletions: rng.int(0, 100),
          changedFiles: rng.int(1, 8),
          firstReviewAt: firstReview,
          // The APPROVAL, which is the same event here: every merged PR below
          // gets exactly one review and its state is APPROVED (W16-46). Leaving
          // this null made two of the three rows of the PR drill-down's stage
          // timeline read "—" on EVERY seeded PR — "First review → approved"
          // and "Approved → merged" blank on a pull request the same screen
          // showed as merged with an approving review beside it.
          firstApprovalAt: firstReview,
          lastActivityAt: mergedAt ?? created,
        })
        .returning();
      prCount++;
      await db
        .insert(facts.prFiles)
        .values({
          workspaceId,
          repoId,
          pullRequestId: pr!.id,
          path: FIXTURE_FILES[p % FIXTURE_FILES.length]!,
          additions: rng.int(1, 50),
          deletions: rng.int(0, 20),
          changeType: 'modified',
        })
        .onConflictDoNothing();
      if (merged) {
        const reviewerId = rng.pick(humanIds.filter((id) => id !== authorId));
        await db.insert(facts.prReviews).values({
          workspaceId,
          repoId,
          pullRequestId: pr!.id,
          forgeReviewId: `${name}-rv${p}`,
          reviewerIdentityId: reviewerId,
          state: 'APPROVED',
          submittedAt: firstReview!,
        });
      }
      // a check run per PR (mix pass/fail)
      const started = new Date(created.getTime() + 3600 * 1000);
      const failed = p % 4 === 0;
      await db.insert(facts.checkRuns).values({
        workspaceId,
        repoId,
        forgeRunId: `${name}-run${p}`,
        kind: 'check_run',
        workflowName: 'ci',
        headSha,
        status: 'completed',
        conclusion: failed ? 'failure' : 'success',
        runAttempt: 1,
        startedAt: started,
        completedAt: new Date(started.getTime() + rng.int(2, 20) * 60000),
      });
      // W4-15: a RERUN of the failed run that passes. Flakiness (METRICS.md §1
      // M9) is fail→pass on the same head SHA, so without a second attempt the
      // fixture has no flakiness to measure at all — and the CI tab's flaky
      // ranking would render an empty state that looks like a broken endpoint.
      if (failed) {
        const rerunStart = new Date(started.getTime() + 30 * 60000);
        await db.insert(facts.checkRuns).values({
          workspaceId,
          repoId,
          forgeRunId: `${name}-run${p}-a2`,
          kind: 'check_run',
          workflowName: 'ci',
          headSha,
          status: 'completed',
          conclusion: 'success',
          runAttempt: 2,
          startedAt: rerunStart,
          completedAt: new Date(rerunStart.getTime() + rng.int(2, 20) * 60000),
        });
      }
    }

    // issues, release, deployment
    for (let i = 4; i <= 6; i++) {
      const closed = i === 4;
      await db.insert(facts.issues).values({
        workspaceId,
        repoId,
        number: i + 10,
        authorIdentityId: rng.pick(humanIds),
        state: closed ? 'closed' : 'open',
        createdAt: new Date(BASE + i * DAY),
        closedAt: closed ? new Date(BASE + (i + 3) * DAY) : null,
        isPullRequest: false,
      });
    }
    await db.insert(facts.releases).values({
      workspaceId,
      repoId,
      forgeReleaseId: `${name}-rel1`,
      tag: 'v1.0.0',
      name: 'v1.0.0',
      isDraft: false,
      isPrerelease: false,
      publishedAt: new Date(BASE + 35 * DAY),
    });
    await db.insert(facts.deployments).values({
      workspaceId,
      repoId,
      forgeDeploymentId: `${name}-dep1`,
      environment: 'production',
      sha: `${name}-c6`,
      createdAt: new Date(BASE + 36 * DAY),
      latestStatus: 'success',
      statusUpdatedAt: new Date(BASE + 36 * DAY),
    });
    await db
      .insert(core.syncCursors)
      .values({ workspaceId, repoId, entityType: 'prs', cursorValue: null, backfillDone: true })
      .onConflictDoNothing();
  }

  // --- metric_snapshots: M1..M12 × every window × per repo + org rollup ---
  //
  // A SERIES, not a single point. The original seeder wrote one row per
  // (scope × metric) in the '30d' bucket only, which produced three separate
  // failures downstream: a sparkline needs >=2 points so it never rendered; a
  // trend delta needs a prior window so every tile showed no change; and any
  // request for 7d/90d/365d matched nothing, so all five KPI tiles rendered em
  // dashes. Points run weekly backwards from the anchor.
  const METRICS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12'];
  // M2 is a hotspot SCORE, catalogued as "score 0-1" (METRICS.md M2). It was
  // outside this set, so it was seeded as a bare level in the tens — the same
  // shape of wrong as M8 below, and on a metric whose whole range is 0..1.
  const RATIOS = new Set(['M2', 'M5', 'M6', 'M9']);

  // PLAUSIBLE FOR THE VOLUME THAT WAS SEEDED (W16-27, B6).
  //
  // Every non-ratio metric shared one anonymous `rng.int(20, 180)` walk
  // clamped to 400, so the fixture reported 175 stale PRs across 15 seeded
  // PRs, roughly 300 releases against three, and a bus factor of 90 over four
  // contributors. It is the demo that people judge the product by, and an
  // impossible number there is not a cosmetic problem: M8 at 175 is also what
  // dragged reviewHygiene to zero, so the headline health scores were shaped
  // by a number no repository could produce.
  //
  // Bands are expressed AGAINST THE SEEDED VOLUME rather than as magic
  // numbers, so a fixture that grows stays honest instead of quietly
  // reacquiring the same bug. Per repo below; the org rollup scales by the
  // repo count, because that is what a rollup is.
  // `humans` tracks CONTRIBUTORS, so adding the demo committer (W16-13) moves
  // the bus-factor ceiling with it rather than leaving a number that used to
  // be true.
  const PER_REPO = {
    commits: 8,
    prs: 5,
    openPrs: 2,
    issues: 3,
    releases: 1,
    humans: CONTRIBUTORS.length,
  };
  //
  // `additive` is the half that is easy to get wrong, and the first version of
  // this fix did: a COUNT sums across repos, and an AVERAGE does not. Scaling
  // everything by the repo count put the org's PR cycle time at 823 hours —
  // five weeks — on a fixture whose PRs merge in one to six days. Three repos
  // do not make a pull request slower.
  interface Band {
    min: number;
    max: number;
    drift: number;
    /** True only for a metric the org rollup SUMS rather than averages. */
    additive?: boolean;
  }
  const BANDS: Record<string, Band> = {
    // Lines changed across 8 commits of 1-3 files each. A total, so additive.
    M1: { min: 120, max: 900, drift: 60, additive: true },
    // Bus factor is a COUNT OF PEOPLE and cannot exceed the contributors — and
    // the org's bus factor is not the repos' added together.
    M3: { min: 1, max: PER_REPO.humans, drift: 1 },
    // PR cycle time in hours: a few hours to a fortnight. An average.
    M4: { min: 4, max: 320, drift: 24 },
    // PR size in lines — the seeder writes additions of 5..300. A distribution
    // point, not a total.
    M7: { min: 20, max: 320, drift: 30 },
    // THE ONE THIS TICKET IS ABOUT: stale PRs cannot exceed the OPEN ones.
    M8: { min: 0, max: PER_REPO.openPrs, drift: 1, additive: true },
    // Issues opened or closed in the window; 3 exist per repo.
    M10: { min: 0, max: PER_REPO.issues, drift: 1, additive: true },
    // Releases in the window; one is seeded per repo.
    M11: { min: 0, max: PER_REPO.releases + 1, drift: 1, additive: true },
    // DORA is mixed units by construction (deploy frequency, lead time in
    // hours, change-failure count), so it gets the widest honest band rather
    // than a precise one that would be precise about the wrong thing — and it
    // is NOT scaled, because a summed lead time is meaningless.
    M12: { min: 1, max: 72, drift: 8 },
  };
  const scaleFor = (repoId: number | null, band: Band): Band =>
    repoId === null && band.additive === true
      ? {
          min: band.min * repoIds.length,
          max: band.max * repoIds.length,
          drift: Math.max(1, band.drift * repoIds.length),
        }
      : band;
  // THE WINDOWS HAVE TO NEST (W16-45).
  //
  // Each (scope, metric, WINDOW) used to get its own independent random walk,
  // so the four windows of one metric were four unrelated series. The demo
  // showed acme/payments at a 30% CI pass rate over 7d and 90% over 365d on the
  // same dates — a year-long window that contains the week cannot disagree with
  // it like that. Moving the window control swung every rate on the screen with
  // no explanation a reader could construct, on the fixture that people judge
  // the product by.
  //
  // So: ONE underlying process per (scope, metric), and each window is that
  // process smoothed by its own length. That is what a rolling window IS — a
  // longer one is a longer average of the same measurements — and it reproduces
  // the relationship a reader expects: every window sits at the same level, and
  // the short ones are the volatile ones.
  //
  // EWMA rather than a boxcar mean because the series is only SERIES_POINTS
  // long: 90d and 365d both exceed it, and a trailing mean would render them as
  // the same line, quietly suggesting the two windows measure the same thing.
  const POINT_DAYS = 7; // points are weekly
  const smoothing = (windowDays: number): number => 2 / (windowDays / POINT_DAYS + 1);
  const WINDOW_DAYS_SEED: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

  const snapshotRows: (typeof read.metricSnapshots.$inferInsert)[] = [];
  for (const repoId of [...repoIds, null]) {
    for (const mk of METRICS) {
      const band = scaleFor(repoId, BANDS[mk] ?? { min: 1, max: 100, drift: 10 });
      const isRatio = RATIOS.has(mk);

      // The underlying process, oldest → newest. Random walk clamped to the
      // metric's OWN band, so deltas are non-zero and a sparkline moves while
      // no point can leave the range the seeded data could actually produce.
      const base: number[] = [];
      let ratioTenths = rng.int(3, 9);
      let level = rng.int(band.min, band.max);
      for (let t = 0; t < SERIES_POINTS; t++) {
        ratioTenths = Math.min(10, Math.max(1, ratioTenths + rng.int(-1, 1)));
        level = Math.min(band.max, Math.max(band.min, level + rng.int(-band.drift, band.drift)));
        base.push(isRatio ? ratioTenths / 10 : level);
      }
      // A denominator the numbers can be READ against: for M9 it is the run
      // count the CI tab prints, so "80% of 24 runs" is one coherent sentence
      // rather than a rate beside an unrelated total. Expressed per 30 days and
      // scaled per window below, because a count of runs GROWS with the window
      // — a fixed one made the CI tab print the same "Runs 38" at 7d and 365d.
      const denominatorPer30d = isRatio ? rng.int(12, 48) : null;

      for (const window of WINDOWS) {
        const windowDays = WINDOW_DAYS_SEED[window] ?? 30;
        const alpha = smoothing(windowDays);
        const denominator =
          denominatorPer30d === null
            ? null
            : Math.max(1, Math.round((denominatorPer30d * windowDays) / 30));
        // Seeded at the process mean so a long window starts where it belongs
        // instead of spending the series climbing away from an arbitrary
        // first point.
        let ewma = base.reduce((a, b) => a + b, 0) / base.length;
        for (let t = 0; t < SERIES_POINTS; t++) {
          ewma = alpha * base[t]! + (1 - alpha) * ewma;
          // i counts DOWN to the newest point, which lands on the anchor end.
          const i = SERIES_POINTS - 1 - t;
          const numerator = denominator === null ? null : Math.round(ewma * denominator);
          snapshotRows.push({
            workspaceId,
            repoId,
            metricKey: mk,
            window,
            value: isRatio ? ewma.toFixed(6) : String(Math.round(ewma)),
            numerator: numerator === null ? null : String(numerator),
            denominator: denominator === null ? null : String(denominator),
            // W4-15: M9's newest row carries the three components compute.ts
            // now writes. Only the newest, because that is what the CI tab
            // reads — and because older rows genuinely predate the change,
            // which the endpoint reports as components_available: false. A
            // fixture that back-filled every row would hide that state instead
            // of letting a screen be tested against it.
            dims: mk === 'M9' && i === 0 ? m9Dims(rng, ewma, denominator ?? 0) : {},
            computedAt: new Date(BASE + SPAN_DAYS * DAY - i * 7 * DAY),
          });
        }
      }
    }
  }
  // One batched insert: ~1.5k rows one-at-a-time made seeding the slowest step
  // in every e2e run.
  for (let i = 0; i < snapshotRows.length; i += 500) {
    await db.insert(read.metricSnapshots).values(snapshotRows.slice(i, i + 500));
  }
  const snapshotCount = snapshotRows.length;

  // Findings (W6-04). Without these the Findings Explorer can only ever be
  // exercised against its empty state — which is how W5-04 shipped a Report
  // Center whose every report was empty and still passed its own e2e.
  const [analysisRun] = await db
    .insert(read.analysisRuns)
    .values({
      workspaceId,
      repoId: repoIds[0]!,
      pullRequestId: null,
      tier: 2,
      dimension: 'security',
      checklistVersion: 'v1',
      modelId: 'fixture-model',
      status: 'succeeded',
      chunkCount: 3,
      promptTokens: 12_000,
      outputTokens: 2_400,
      startedAt: new Date(BASE + SPAN_DAYS * DAY - DAY),
      finishedAt: new Date(BASE + SPAN_DAYS * DAY - DAY + 45_000),
    })
    .returning();

  const findingSeeds = [
    {
      dimension: 'security',
      severity: 5,
      confidence: 5,
      title: 'SQL built by string concatenation',
      // The scanner each fixture finding is meant to have come from (W16-40).
      // Without it these three carried a NULL scanner_key, and the Findings
      // Explorer's Scanner facet silently dropped them: picking ANY scanner
      // hid three of the demo's findings with nothing saying why. In a real
      // install every finding has a scanner, so a fixture without one is not a
      // simpler fixture — it is an impossible row.
      scannerKey: 'owasp_web',
      file: 'src/payments/charge.ts',
      evidence: "db.query('select * from charges where id = ' + req.params.id)",
      recommendation: 'Use a parameterised query.',
    },
    {
      dimension: 'performance',
      severity: 4,
      confidence: 4,
      title: 'Query inside a loop over pull requests',
      scannerKey: 'performance',
      file: 'src/reports/build.ts',
      evidence: 'for (const pr of prs) { await db.select().from(reviews) }',
      recommendation: 'Batch the lookup outside the loop.',
    },
    {
      dimension: 'code_health',
      severity: 2,
      confidence: 3,
      title: 'Empty catch swallows the failure',
      scannerKey: 'code_health_tools',
      file: 'src/sync/webhook.ts',
      evidence: 'catch { }',
      recommendation: 'Log the error or let it propagate.',
    },
  ];

  // ONE finding attached to a pull request (W16-46), so the PR drill-down's
  // Automated review panel has something to show. Every seeded finding carried
  // `pullRequestId: null`, and that panel was hardcoded to its empty state, so
  // neither half of the feature could contradict the other.
  //
  // Attached to the PR THAT TOUCHED THE FINDING'S FILE, looked up rather than
  // assumed. The first version of this picked the first PR by number and the
  // demo then showed an "automated review" of src/payments/charge.ts on a pull
  // request whose only file was src/reports/build.ts — a diff review reporting
  // something that was not in the diff.
  const [reviewedPr] = await db
    .select({ pullRequestId: facts.prFiles.pullRequestId })
    .from(facts.prFiles)
    .where(
      and(
        eq(facts.prFiles.workspaceId, workspaceId),
        eq(facts.prFiles.repoId, repoIds[0]!),
        eq(facts.prFiles.path, findingSeeds[0]!.file),
      ),
    )
    .limit(1);

  await db.insert(read.findings).values(
    findingSeeds.map((f, i) => ({
      workspaceId,
      repoId: repoIds[0]!,
      analysisRunId: analysisRun!.id,
      pullRequestId: i === 0 ? (reviewedPr?.pullRequestId ?? null) : null,
      dimension: f.dimension,
      severity: f.severity,
      confidence: f.confidence,
      title: f.title,
      scannerKey: f.scannerKey,
      file: f.file,
      lineStart: 10 + i * 25,
      lineEnd: 12 + i * 25,
      evidence: f.evidence,
      recommendation: f.recommendation,
      tier: 2,
      // Deterministic keys: re-seeding must not create a second copy, the same
      // property the store guarantees in production.
      dedupKey: `fixture-${f.dimension}-${i}`,
      status: 'open',
      // W6-05: one of each verification state, so the Explorer facet and the
      // challenger gate are exercised against data rather than an empty filter.
      // The critical SQL finding is confirmed by a second model; the low
      // severity one was contradicted on review.
      verifyStatus: i === 0 ? 'confirmed' : i === 2 ? 'contradicted' : 'unverified',
    })),
  );

  return {
    workspaceId,
    secondWorkspaceId,
    fixtureUserId: fixtureUser!.id,
    fixtureIdentityId: identityIds.get(FIXTURE_LOGIN)!,
    /** demo.ts links its local account to this one (W16-13). */
    demoIdentityId: identityIds.get(DEMO_LOGIN)!,
    repoIds,
    counts: { repos: repoIds.length, commits: commitCount, prs: prCount, snapshots: snapshotCount },
  };
}

/** Remove every row the seeder created (both workspaces + the fixture user). */
export async function unseedWarehouse(db: Database): Promise<void> {
  const wss = await db
    .select({ id: core.workspaces.id })
    .from(core.workspaces)
    .where(inArray(core.workspaces.slug, [SEED_DEFAULT_SLUG, SEED_SECOND_SLUG]));
  for (const w of wss) {
    await wipeWorkspace(db, w.id);
    await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.workspaceId, w.id));
  }
  await db.delete(core.users).where(eq(core.users.forgeUserId, FIXTURE_LOGIN));
}
