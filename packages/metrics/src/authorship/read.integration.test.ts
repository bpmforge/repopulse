import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb, facts, read, security, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeAiGovernance } from './read.js';
import { AI_AUTHORSHIP_SETTINGS_KEY } from './patterns.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const DAY = 86_400_000;
const END = new Date('2026-09-30T00:00:00Z');
const at = (daysBeforeEnd: number) => new Date(END.getTime() - daysBeforeEnd * DAY);
const AI = ['Co-authored-by: Claude <noreply@anthropic.com>'];

// W18-20: the warehouse path end to end — the readers, the shared M13/M5
// readers, the workspace's pattern list, and the two invariants a unit test
// cannot prove: tenancy and the pinned window end.

describeIfLiveInfra('computeAiGovernance (W18-20)', () => {
  const db: Database = createDb(databaseUrl as string);
  const SLUGS = ['w18-20-gov-a', 'w18-20-gov-b'];
  const ws: number[] = [];
  const repos: number[] = [];

  async function cleanup(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const repoRows = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(inArray(core.repos.workspaceId, ids));
    const repoIds = repoRows.map((r) => r.id);
    if (repoIds.length > 0) {
      await db.delete(read.findings).where(inArray(read.findings.repoId, repoIds));
      await db.delete(security.scanRuns).where(inArray(security.scanRuns.repoId, repoIds));
      await db.delete(facts.prReviews).where(inArray(facts.prReviews.repoId, repoIds));
      await db.delete(facts.commitFiles).where(inArray(facts.commitFiles.repoId, repoIds));
      await db.delete(facts.commits).where(inArray(facts.commits.repoId, repoIds));
      await db.delete(facts.pullRequests).where(inArray(facts.pullRequests.repoId, repoIds));
      await db.delete(core.repos).where(inArray(core.repos.id, repoIds));
    }
    await db.delete(core.identities).where(inArray(core.identities.workspaceId, ids));
    await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.workspaceId, ids));
  }

  beforeAll(async () => {
    for (const slug of SLUGS) {
      const [w] = await db
        .insert(core.workspaces)
        .values({ slug, name: slug })
        .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: slug, settings: {} } })
        .returning();
      ws.push(w!.id);
    }
    await cleanup(ws);
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w18-20-gov',
        forgeUserId: 'w18-20-gov',
        login: 'w18-20-gov',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w18-20-gov' } })
      .returning();

    for (const workspaceId of ws) {
      const [conn] = await db
        .insert(core.forgeConnections)
        .values({
          workspaceId,
          provider: 'github',
          authKind: 'pat',
          credentialCiphertext: Buffer.from('x'),
          credentialIv: Buffer.from('iv-1234567890123'),
          keyVersion: 1,
          credentialFingerprint: `w18-20-${workspaceId}`,
          status: 'active',
          createdBy: user!.id,
        })
        .returning();
      const [repo] = await db
        .insert(core.repos)
        .values({
          workspaceId,
          connectionId: conn!.id,
          forgeRepoId: `w18-20-${workspaceId}`,
          org: 'acme',
          name: 'gov',
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        })
        .returning();
      repos.push(repo!.id);
      const [alice] = await db
        .insert(core.identities)
        .values({ workspaceId, provider: 'github', forgeLogin: 'alice-dev', displayName: 'Alice' })
        .returning();
      // A person other than the author: since W18-23 a bot's review is not
      // review (METRICS.md §0), so the PR's approval has to come from a human.
      const [reviewer] = await db
        .insert(core.identities)
        .values({ workspaceId, provider: 'github', forgeLogin: 'bob-reviewer', displayName: 'Bob' })
        .returning();
      const [bot] = await db
        .insert(core.identities)
        .values({
          workspaceId,
          provider: 'github',
          forgeLogin: 'dependabot[bot]',
          displayName: 'dependabot',
          isBot: true,
        })
        .returning();

      const addCommit = async (
        sha: string,
        daysBefore: number,
        opts: {
          trailers?: string[] | null;
          author?: number;
          messageHead?: string;
          path?: string;
          revert?: boolean;
        } = {},
      ) => {
        const [c] = await db
          .insert(facts.commits)
          .values({
            workspaceId,
            repoId: repo!.id,
            sha,
            authorIdentityId: opts.author ?? alice!.id,
            committerIdentityId: opts.author ?? alice!.id,
            authoredAt: at(daysBefore),
            committedAt: at(daysBefore),
            messageHead: opts.messageHead ?? sha,
            trailers: opts.trailers === undefined ? [] : opts.trailers,
            isRevertHeuristic: opts.revert ?? false,
            isMerge: false,
          })
          .returning();
        await db.insert(facts.commitFiles).values({
          workspaceId,
          repoId: repo!.id,
          commitId: c!.id,
          path: opts.path ?? `${sha}.ts`,
          additions: 50,
          deletions: 0,
          status: 'modified',
        });
      };

      await addCommit('h1', 10, { path: 'a.ts' });
      await addCommit('ai1', 8, { trailers: AI, path: 'a.ts' }); // reworks h1 (2 days later)
      await addCommit('ai2', 5, { trailers: AI, revert: true });
      await addCommit('pr7', 4, { messageHead: 'Agent work (#7)' }); // via its claude/ PR
      await addCommit('old', 3, { trailers: null }); // pre-0035 row
      await addCommit('dep', 2, { author: bot!.id });
      await addCommit('future', -5, { trailers: AI }); // after the pinned end

      const [pr] = await db
        .insert(facts.pullRequests)
        .values({
          workspaceId,
          repoId: repo!.id,
          number: 7,
          forgePrId: `pr7-${workspaceId}`,
          title: 'agent work',
          authorIdentityId: alice!.id,
          state: 'merged',
          isDraft: false,
          isBot: false,
          createdAt: at(6),
          updatedAt: at(4),
          mergedAt: at(4),
          baseRef: 'main',
          headSha: 'head7',
          headRef: 'claude/agent-work',
          additions: 50,
          deletions: 0,
          changedFiles: 1,
        })
        .returning();
      await db.insert(facts.prReviews).values({
        workspaceId,
        repoId: repo!.id,
        pullRequestId: pr!.id,
        forgeReviewId: `rv-${workspaceId}`,
        reviewerIdentityId: reviewer!.id,
        state: 'APPROVED',
        submittedAt: at(5),
      });

      const [scan] = await db
        .insert(security.scanRuns)
        .values({
          workspaceId,
          repoId: repo!.id,
          scannerKey: 'semgrep',
          scannerVersion: 'x',
          commitSha: 'h1',
          trigger: 'manual',
          status: 'succeeded',
          startedAt: at(1),
        })
        .returning();
      await db.insert(read.findings).values({
        workspaceId,
        repoId: repo!.id,
        scanRunId: scan!.id,
        dimension: 'security',
        severity: 3,
        confidence: 3,
        title: 'x',
        file: 'a.ts',
        lineStart: 1,
        lineEnd: 1,
        evidence: 'e',
        recommendation: 'r',
        tier: 1,
        dedupKey: `w18-20-${workspaceId}`,
        status: 'open',
        firstSeenAt: at(1),
      });
    }
  });

  afterAll(async () => {
    await cleanup(ws);
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w18-20-gov'));
    await db.delete(core.workspaces).where(inArray(core.workspaces.id, ws));
    await db.$client.end();
  });

  it('classifies, slices and bounds the window; counts only this workspace', async () => {
    const g = await computeAiGovernance(db, {
      workspaceId: ws[0]!,
      repoIds: [],
      windowEnd: END,
      windowDays: 30,
    });
    expect(g.repoCount).toBe(1);
    // ai1, ai2, pr7 (linked to its claude/ PR); h1 human; `old` unknown;
    // dependabot automation; `future` is after the pinned end.
    expect(g.counts).toMatchObject({
      aiCommits: 3,
      humanCommits: 1,
      unknownCommits: 1,
      automationCommits: 1,
      aiPrs: 1,
    });
    expect(g.aiCommitSignals).toMatchObject({ trailer: 2, linked_pr: 1 });
    const m = Object.fromEntries(g.measures.map((x) => [x.key, x]));
    expect(m.rework_14d).toMatchObject({ ai: 50 / 150, human: 0, aiSample: 150, humanSample: 50 });
    expect(m.revert_rate).toMatchObject({ ai: 1 / 3, human: 0 });
    // The finding on a.ts was first seen after ai1 last touched it.
    expect(m.findings_per_kloc!.ai).toBeCloseTo(1000 / 150);
    expect(m.review_coverage).toMatchObject({ ai: 1, aiSample: 1 });
    // Far below every minimum: nothing is set side by side as a comparison.
    expect(g.anyComparable).toBe(false);
    expect(JSON.stringify(g)).not.toContain('alice');
  });

  it('applies the workspace pattern list on read', async () => {
    await db
      .update(core.workspaces)
      .set({
        settings: { [AI_AUTHORSHIP_SETTINGS_KEY]: { trailer_patterns: [], branch_prefixes: [] } },
      })
      .where(eq(core.workspaces.id, ws[1]!));
    const g = await computeAiGovernance(db, {
      workspaceId: ws[1]!,
      repoIds: [repos[1]!],
      windowEnd: END,
      windowDays: 30,
    });
    expect(g.counts.aiCommits).toBe(0);
    expect(g.counts.humanCommits).toBe(4);
  });

  it('a repo id from another workspace yields nothing', async () => {
    const g = await computeAiGovernance(db, {
      workspaceId: ws[0]!,
      repoIds: [repos[1]!],
      windowEnd: END,
      windowDays: 30,
    });
    expect(g.repoCount).toBe(0);
    expect(g.aiShareCommits).toBeNull();
  });
});
