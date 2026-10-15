import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, facts, read, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeRepoSnapshots } from './compute.js';
import { readReviewBotInputs } from './readers.js';
import { computeReviewBotMetrics } from '../metrics/review-bots.js';
import type { CycleStagePercentiles } from '../metrics/cycle.js';

// W18-23 against the real warehouse: AI review bots stay out of every
// human-flow metric (METRICS.md §0) while their own activity is measured
// from the same rows (§5).
//
// The fixture is the failure as it would have shipped: a PR whose ONLY
// reviewers are CodeRabbit and Copilot, and a PR where CodeRabbit answered
// in six minutes and a person took ten hours. Before W18-23 the first PR read
// as review-covered (M5) and the second's open→firstReview (M4) was 0.1h.
// `Copilot` is deliberately stored with identities.is_bot = false — the login
// GitHub uses for it has no `[bot]` suffix, so only the registry catches it.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const ASOF = new Date('2026-07-19T00:00:00Z');
const OPENED = new Date('2026-07-10T00:00:00Z');
const hours = (h: number) => new Date(OPENED.getTime() + h * 3_600_000);
const SLUG = 'w18-23-review-bots';

describeIfLiveInfra('AI review bots vs human-flow metrics (W18-23)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoId: number;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: SLUG, name: SLUG })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: SLUG } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: SLUG, forgeUserId: SLUG, login: SLUG })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: SLUG } })
      .returning();
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'r-review-bots',
        org: 'acme',
        name: 'review-bots',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    const identity = async (login: string, isBot: boolean) => {
      const [row] = await db
        .insert(core.identities)
        .values({ workspaceId, provider: 'github', forgeLogin: login, displayName: login, isBot })
        .returning();
      return row!.id;
    };
    const alice = await identity('alice', false);
    const bob = await identity('bob', false);
    const rabbit = await identity('coderabbitai[bot]', true);
    const copilot = await identity('Copilot', false);

    const insertPr = async (number: number) => {
      const [row] = await db
        .insert(facts.pullRequests)
        .values({
          workspaceId,
          repoId,
          number,
          forgePrId: `PR${number}`,
          title: `pr ${number}`,
          authorIdentityId: alice,
          state: 'merged',
          isDraft: false,
          isBot: false,
          createdAt: OPENED,
          updatedAt: hours(30),
          mergedAt: hours(24),
          closedAt: hours(24),
          baseRef: 'main',
          headSha: `h${number}`,
          additions: 10,
          deletions: 2,
          changedFiles: 1,
          lastActivityAt: hours(24),
          reviewCommentsObservedAt: hours(30),
        })
        .returning();
      return row!.id;
    };
    const botsOnly = await insertPr(1);
    const mixed = await insertPr(2);

    await db.insert(facts.prReviews).values([
      {
        workspaceId,
        repoId,
        pullRequestId: botsOnly,
        forgeReviewId: 'b1',
        reviewerIdentityId: rabbit,
        state: 'COMMENTED',
        submittedAt: hours(0.1),
      },
      {
        workspaceId,
        repoId,
        pullRequestId: botsOnly,
        forgeReviewId: 'b2',
        reviewerIdentityId: copilot,
        state: 'APPROVED',
        submittedAt: hours(0.2),
      },
      {
        workspaceId,
        repoId,
        pullRequestId: mixed,
        forgeReviewId: 'm1',
        reviewerIdentityId: rabbit,
        state: 'COMMENTED',
        submittedAt: hours(0.1),
      },
      {
        workspaceId,
        repoId,
        pullRequestId: mixed,
        forgeReviewId: 'm2',
        reviewerIdentityId: bob,
        state: 'APPROVED',
        submittedAt: hours(10),
      },
    ]);
    const anchor = { workspaceId, repoId, subjectType: 'line', isReply: false };
    await db.insert(facts.prReviewComments).values([
      {
        ...anchor,
        pullRequestId: botsOnly,
        forgeCommentId: 'c1',
        forgeReviewId: 'b1',
        authorIdentityId: rabbit,
        createdAt: hours(0.1),
        path: 'src/a.ts',
        originalLine: 4,
        currentLine: null,
        originalCommitSha: 'h1a',
        commitSha: 'h1a',
      },
      {
        ...anchor,
        pullRequestId: mixed,
        forgeCommentId: 'c2',
        forgeReviewId: 'm1',
        authorIdentityId: rabbit,
        createdAt: hours(0.1),
        path: 'src/b.ts',
        originalLine: 9,
        currentLine: 9,
        originalCommitSha: 'h2',
        commitSha: 'h2',
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, workspaceId));
    await db
      .delete(facts.prReviewComments)
      .where(eq(facts.prReviewComments.workspaceId, workspaceId));
    await db.delete(facts.prReviews).where(eq(facts.prReviews.workspaceId, workspaceId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, SLUG));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  async function latest(metricKey: string) {
    const [row] = await db
      .select()
      .from(read.metricSnapshots)
      .where(
        and(eq(read.metricSnapshots.repoId, repoId), eq(read.metricSnapshots.metricKey, metricKey)),
      );
    return row!;
  }

  it('bot reviews never cover a PR (M5) or start its review clock (M4)', async () => {
    await computeRepoSnapshots(db, {
      workspaceId,
      repoId,
      asOf: ASOF,
      windows: [{ key: '30d', days: 30 }],
    });

    // Only bob's approval of PR 2 is review: 1 of 2 merged PRs covered.
    const m5 = await latest('M5');
    expect(Number(m5.numerator)).toBe(1);
    expect(Number(m5.denominator)).toBe(2);

    // PR 2's first review is bob at 10h, not CodeRabbit at 0.1h; PR 1 has no
    // human review, so it contributes to e2e only.
    const m4 = await latest('M4');
    const stages = (m4.dims as { stages: CycleStagePercentiles }).stages;
    expect(stages.openToFirstReview.median).toBe(10);
    expect(stages.openToFirstReview.p90).toBe(10);
  });

  it('the same rows feed the per-bot metrics (§5)', async () => {
    const inputs = await readReviewBotInputs(
      db,
      { workspaceId, repoId },
      new Date(ASOF.getTime() - 30 * 86_400_000),
    );
    const result = computeReviewBotMetrics(inputs);
    expect(result.lineData).toBe('available');
    expect(result.bots.map((b) => b.key)).toEqual(['coderabbit', 'copilot']);
    const rabbit = result.bots[0]!;
    expect(rabbit.prsReviewed).toBe(2);
    expect(rabbit.timeToFirst.medianHours).toBeCloseTo(0.1);
    expect(rabbit.followedByChange).toMatchObject({ numerator: 1, denominator: 2, pending: 0 });
    const copilot = result.bots[1]!;
    expect(copilot.loginsSeen).toEqual(['Copilot']);
    expect(copilot.prsReviewed).toBe(1);
  });

  it('is workspace-scoped: another workspace reads nothing (Law 5)', async () => {
    const inputs = await readReviewBotInputs(
      db,
      { workspaceId: workspaceId + 1_000_000, repoId },
      new Date(0),
    );
    expect(inputs.prs).toEqual([]);
    expect(inputs.reviews).toEqual([]);
    expect(inputs.comments).toEqual([]);
  });
});
