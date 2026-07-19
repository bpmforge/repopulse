import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { core, facts, read } from '../../db/index.js';
import { makeRng } from './prng.js';

// Deterministic warehouse seeder (W4-00) — one multi-repo org + a second
// workspace, identities incl. the fixture login, facts and metric_snapshot rows
// sufficient for every UX_SPEC §4 screen. Seeded RNG so e2e suites assert on
// exact values. Idempotent: wipes its own workspaces first, then reseeds.

export const SEED_DEFAULT_SLUG = 'default';
export const SEED_SECOND_SLUG = 'seed-second-tenant';
export const FIXTURE_LOGIN = 'fixture-dev';
const CONTRIBUTORS = ['alice', 'bob', 'carol', FIXTURE_LOGIN] as const;
const BOT = 'renovate[bot]';
const REPO_NAMES = ['payments', 'web-app', 'infra'] as const;
const BASE = Date.parse('2026-06-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

export interface SeedResult {
  workspaceId: number;
  secondWorkspaceId: number;
  fixtureUserId: number;
  fixtureIdentityId: number;
  repoIds: number[];
  counts: { repos: number; commits: number; prs: number; snapshots: number };
}

async function wipeWorkspace(db: Database, workspaceId: number): Promise<void> {
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
  await db.delete(core.forgeConnections).where(eq(core.forgeConnections.workspaceId, workspaceId));
}

export async function seedWarehouse(
  db: Database,
  opts: { seed?: number } = {},
): Promise<SeedResult> {
  const rng = makeRng(opts.seed ?? 42);

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
  const [fixtureUser] = await db
    .insert(core.users)
    .values({ forgeUserId: FIXTURE_LOGIN, login: FIXTURE_LOGIN })
    .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: FIXTURE_LOGIN } })
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
      const at = new Date(BASE + (c * 3 + rng.int(0, 2)) * DAY);
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
      const created = new Date(BASE + p * 4 * DAY);
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
        await db
          .insert(facts.prReviews)
          .values({
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
      await db
        .insert(facts.checkRuns)
        .values({
          workspaceId,
          repoId,
          forgeRunId: `${name}-run${p}`,
          kind: 'check_run',
          workflowName: 'ci',
          headSha,
          status: 'completed',
          conclusion: p % 4 === 0 ? 'failure' : 'success',
          runAttempt: 1,
          startedAt: started,
          completedAt: new Date(started.getTime() + rng.int(2, 20) * 60000),
        });
    }

    // issues, release, deployment
    for (let i = 4; i <= 6; i++) {
      const closed = i === 4;
      await db
        .insert(facts.issues)
        .values({
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
    await db
      .insert(facts.releases)
      .values({
        workspaceId,
        repoId,
        forgeReleaseId: `${name}-rel1`,
        tag: 'v1.0.0',
        name: 'v1.0.0',
        isDraft: false,
        isPrerelease: false,
        publishedAt: new Date(BASE + 35 * DAY),
      });
    await db
      .insert(facts.deployments)
      .values({
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

  // --- metric_snapshots: M1..M12 for '30d' per repo + org rollup (null repo) ---
  const METRICS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12'];
  const RATIOS = new Set(['M5', 'M6', 'M9']);
  let snapshotCount = 0;
  const computedAt = new Date(BASE + 40 * DAY);
  for (const repoId of [...repoIds, null]) {
    for (const mk of METRICS) {
      const num = RATIOS.has(mk) ? String(rng.int(3, 9)) : null;
      const den = RATIOS.has(mk) ? '10' : null;
      const value = RATIOS.has(mk) ? (Number(num) / 10).toFixed(6) : String(rng.int(1, 200));
      await db
        .insert(read.metricSnapshots)
        .values({
          workspaceId,
          repoId,
          metricKey: mk,
          window: '30d',
          value,
          numerator: num,
          denominator: den,
          dims: {},
          computedAt,
        });
      snapshotCount++;
    }
  }

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
