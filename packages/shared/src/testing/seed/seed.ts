import { eq, inArray } from 'drizzle-orm';
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
const CONTRIBUTORS = ['alice', 'bob', 'carol', FIXTURE_LOGIN] as const;
const BOT = 'renovate[bot]';
// Exported so specs can target a SEEDED repo by name instead of "whichever
// tile renders first" — the ingest specs legitimately add repos to this same
// workspace, so position is not identity.
export const SEED_REPO_NAMES = ['payments', 'web-app', 'infra'] as const;
const REPO_NAMES = SEED_REPO_NAMES;
const DAY = 24 * 60 * 60 * 1000;

/** The fixture's activity spans this many days, ending at the anchor. */
const SPAN_DAYS = 40;
/** Weekly snapshot points per (scope × metric × window) — >=2 so a sparkline renders. */
const SERIES_POINTS = 8;
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
function m9Dims(rng: Rng): Record<string, unknown> {
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
    passRate: rng.int(70, 99) / 100,
    prPassRate: rng.int(55, 95) / 100,
    defaultBranchRuns: rng.int(8, 40),
    prRuns: rng.int(10, 60),
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
async function wipeWorkspace(db: Database, workspaceId: number): Promise<void> {
  // Analysis/audit rows reference repos.
  await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, workspaceId));
  await db.delete(read.findings).where(eq(read.findings.workspaceId, workspaceId));
  await db.delete(read.analysisRuns).where(eq(read.analysisRuns.workspaceId, workspaceId));
  await db.delete(read.egressAudit).where(eq(read.egressAudit.workspaceId, workspaceId));
  await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, workspaceId));
  await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, workspaceId));
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
  await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
  // Both reference forge_connections and must go before it. forge_etag is the
  // one that actually broke: it is written only when a forge returns an ETag,
  // so it stayed empty until the first real-GitHub run.
  await db.delete(core.forgeEtag).where(eq(core.forgeEtag.workspaceId, workspaceId));
  await db.delete(core.webhookDelivery).where(eq(core.webhookDelivery.workspaceId, workspaceId));
  // Saved views (W5-02). Workspace-scoped like everything above, and missed
  // until something finally created one: saved_views has an FK to users, so a
  // leftover view makes unseedWarehouse's user delete fail with a constraint
  // error from a table the caller never mentioned.
  // SBOMs (W8-02).
  await db.delete(security.sboms).where(eq(security.sboms.workspaceId, workspaceId));
  // Scanner config and runs (W8-01).
  await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, workspaceId));
  await db.delete(security.repoScannerConfig).where(eq(security.repoScannerConfig.workspaceId, workspaceId));
  // File intents (W6-07).
  await db.delete(plans.fileIntents).where(eq(plans.fileIntents.workspaceId, workspaceId));
  // Agreements (W5-08).
  await db.delete(plans.agreements).where(eq(plans.agreements.workspaceId, workspaceId));
  // Plans (W5-06). Children first: plan_item_events -> plan_items ->
  // improvement_plans, since each FKs the one before it.
  await db.delete(plans.planItemEvents).where(eq(plans.planItemEvents.workspaceId, workspaceId));
  await db.delete(plans.planItems).where(eq(plans.planItems.workspaceId, workspaceId));
  await db.delete(plans.improvementPlans).where(eq(plans.improvementPlans.workspaceId, workspaceId));
  // Reports (W5-04), for the same reason as saved views directly below: the
  // row FKs to users, so a leftover report makes unseedWarehouse's user delete
  // fail with a constraint error naming a table the caller never mentioned.
  // Second time this exact gap has surfaced — every future workspace-scoped
  // table needs a line here.
  await db.delete(read.reports).where(eq(read.reports.workspaceId, workspaceId));
  await db.delete(read.savedViews).where(eq(read.savedViews.workspaceId, workspaceId));
  await db.delete(core.forgeConnections).where(eq(core.forgeConnections.workspaceId, workspaceId));
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
  await wipeWorkspace(db, workspaceId);
  await wipeWorkspace(db, secondWorkspaceId);

  // --- users + membership (fixture is admin) ---
  // W4-10: the fixture user carries a PERSONA. A null persona is what opens the
  // first-login picker (UX_SPEC §6), and a modal over every seeded screen would
  // break every e2e for a reason having nothing to do with what they assert.
  // The picker's own spec clears the column first, so it still tests the real
  // first-login state rather than a mock of it.
  const [fixtureUser] = await db
    .insert(core.users)
    .values({ authProvider: 'github', authSubject: FIXTURE_LOGIN, forgeUserId: FIXTURE_LOGIN, login: FIXTURE_LOGIN, persona: 'lead' })
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

  const [conn] = await db
    .insert(core.forgeConnections)
    .values({
      workspaceId,
      provider: 'github',
      authKind: 'pat',
      credentialCiphertext: Buffer.from('seed'),
      credentialIv: Buffer.from('iv-seed-1234567'),
      keyVersion: 1,
      credentialFingerprint: 'seed:fp',
      status: 'active',
      createdBy: fixtureUser!.id,
    })
    .returning();

  // --- identities (incl. the fixture login + a bot) ---
  const identityIds = new Map<string, number>();
  for (const login of [...CONTRIBUTORS, BOT]) {
    const [id] = await db
      .insert(core.identities)
      .values({
        workspaceId,
        provider: 'github',
        forgeLogin: login,
        forgeUserId: login === FIXTURE_LOGIN ? FIXTURE_LOGIN : `id-${login}`,
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
            path: `src/mod${(ri + f) % 4}.ts`,
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
      const mergedAt = merged ? new Date(created.getTime() + rng.int(1, 6) * DAY) : null;
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
          additions: rng.int(5, 300),
          deletions: rng.int(0, 100),
          changedFiles: rng.int(1, 8),
          firstReviewAt: firstReview,
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
          path: `src/mod${p % 4}.ts`,
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
  const RATIOS = new Set(['M5', 'M6', 'M9']);
  const snapshotRows: (typeof read.metricSnapshots.$inferInsert)[] = [];
  for (const repoId of [...repoIds, null]) {
    for (const mk of METRICS) {
      for (const window of WINDOWS) {
        // One walk per (scope, metric, window) so each series drifts on its own
        // rather than every tile moving in lockstep.
        let ratioTenths = rng.int(3, 9);
        let level = rng.int(20, 180);
        for (let i = SERIES_POINTS - 1; i >= 0; i--) {
          // Random walk, clamped, so deltas are non-zero but values stay sane.
          ratioTenths = Math.min(10, Math.max(1, ratioTenths + rng.int(-1, 1)));
          level = Math.min(400, Math.max(1, level + rng.int(-15, 15)));
          const isRatio = RATIOS.has(mk);
          snapshotRows.push({
            workspaceId,
            repoId,
            metricKey: mk,
            window,
            value: isRatio ? (ratioTenths / 10).toFixed(6) : String(level),
            numerator: isRatio ? String(ratioTenths) : null,
            denominator: isRatio ? '10' : null,
            // W4-15: M9's newest row carries the three components compute.ts
            // now writes. Only the newest, because that is what the CI tab
            // reads — and because older rows genuinely predate the change,
            // which the endpoint reports as components_available: false. A
            // fixture that back-filled every row would hide that state instead
            // of letting a screen be tested against it.
            dims: mk === 'M9' && i === 0 ? m9Dims(rng) : {},
            // i = 0 is the newest point and lands on the anchor end (today).
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
      file: 'src/payments/charge.ts',
      evidence: "db.query('select * from charges where id = ' + req.params.id)",
      recommendation: 'Use a parameterised query.',
    },
    {
      dimension: 'performance',
      severity: 4,
      confidence: 4,
      title: 'Query inside a loop over pull requests',
      file: 'src/reports/build.ts',
      evidence: 'for (const pr of prs) { await db.select().from(reviews) }',
      recommendation: 'Batch the lookup outside the loop.',
    },
    {
      dimension: 'code_health',
      severity: 2,
      confidence: 3,
      title: 'Empty catch swallows the failure',
      file: 'src/sync/webhook.ts',
      evidence: 'catch { }',
      recommendation: 'Log the error or let it propagate.',
    },
  ];

  await db.insert(read.findings).values(
    findingSeeds.map((f, i) => ({
      workspaceId,
      repoId: repoIds[0]!,
      analysisRunId: analysisRun!.id,
      pullRequestId: null,
      dimension: f.dimension,
      severity: f.severity,
      confidence: f.confidence,
      title: f.title,
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
