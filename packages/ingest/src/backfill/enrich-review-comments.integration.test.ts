import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import {
  GitHubProvider,
  GiteaProvider,
  createAuthHeaderProvider,
  type ForgeHttpClient,
  type ForgeProvider,
  type ForgeResponse,
} from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrichPullRequest } from './enrich-pr.js';

// W18-23: per-PR enrichment also fetches inline review-comment ANCHORS where
// the adapter can (GitHub), through the real adapter over a canned client. The
// three outcomes the AI-reviewer metrics depend on:
//   fetched  → rows (no body), PR stamped review_comments_observed_at, even
//              when there are zero comments;
//   refused  → recorded on sync_cursors('review_comments'), PR NOT stamped, so
//              the metrics read "no line data" rather than "zero comments";
//   Gitea    → no fetch at all, no stamp, nothing recorded.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const GH = 'https://api.github.com/repos';
type Canned = Record<string, { status: number; body: unknown; headers?: Record<string, string> }>;

function clientOver(canned: Canned): ForgeHttpClient {
  return {
    request: (_ctx, req): Promise<ForgeResponse> => {
      const r = canned[req.url];
      if (!r) throw new Error(`canned client: no response for ${req.method} ${req.url}`);
      return Promise.resolve({
        status: r.status,
        headers: r.headers ?? {},
        body: r.body,
        servedFromCache: false,
      });
    },
  };
}

const auth = createAuthHeaderProvider({ kind: 'pat', token: 'w18-23-test' });

function githubCanned(repo: string, n: number, sha: string, comments: Canned): Canned {
  return {
    [`${GH}/${repo}/pulls/${n}/reviews?per_page=100`]: {
      status: 200,
      body: [
        {
          id: 501,
          user: { login: 'Copilot' },
          state: 'COMMENTED',
          submitted_at: '2026-09-01T00:05:00Z',
        },
      ],
    },
    [`${GH}/${repo}/commits/${sha}/check-runs?per_page=100`]: {
      status: 200,
      body: { total_count: 0, check_runs: [] },
    },
    ...comments,
  };
}

describeIfLiveInfra('review-comment anchors in PR enrichment (W18-23)', () => {
  const db: Database = createDb(databaseUrl as string);
  const slug = 'w18-23-enrich';
  let workspaceId: number;
  let connectionId: number;
  let authorId: number;

  async function makeRepoAndPr(name: string, number: number, sha: string) {
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: `${slug}-${name}`,
        org: 'acme',
        name,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'backfilling',
        tier2Auto: false,
      })
      .returning();
    const [pr] = await db
      .insert(facts.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number,
        forgePrId: `${slug}-${name}-${number}`,
        title: 'pr',
        authorIdentityId: authorId,
        state: 'merged',
        isDraft: false,
        isBot: false,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date('2026-09-02T00:00:00Z'),
        mergedAt: new Date('2026-09-02T00:00:00Z'),
        baseRef: 'main',
        headSha: sha,
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      })
      .returning();
    return { repoId: repo!.id, prId: pr!.id };
  }

  async function observedAt(prId: number) {
    const [row] = await db
      .select({ at: facts.pullRequests.reviewCommentsObservedAt })
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.id, prId));
    return row!.at;
  }

  async function refusal(repoId: number) {
    const [row] = await db
      .select({ lastError: core.syncCursors.lastError })
      .from(core.syncCursors)
      .where(
        and(
          eq(core.syncCursors.repoId, repoId),
          eq(core.syncCursors.entityType, 'review_comments'),
        ),
      );
    return row?.lastError ?? null;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug, name: slug })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: slug } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: slug, forgeUserId: slug, login: slug })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: slug } })
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
    connectionId = conn!.id;
    const [author] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'github', forgeLogin: 'alice', displayName: 'alice' })
      .returning();
    authorId = author!.id;
  });

  afterAll(async () => {
    const ws = eq(facts.prReviewComments.workspaceId, workspaceId);
    await db.delete(facts.prReviewComments).where(ws);
    await db.delete(facts.prReviews).where(eq(facts.prReviews.workspaceId, workspaceId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, slug));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('GitHub: stores anchors across pages, no body, and stamps the PR', async () => {
    const repo = 'acme/fetched';
    const { repoId, prId } = await makeRepoAndPr('fetched', 7, 'sha7');
    const commentsUrl = `${GH}/${repo}/pulls/7/comments?per_page=100`;
    const provider = new GitHubProvider({
      auth,
      client: clientOver(
        githubCanned(repo, 7, 'sha7', {
          [commentsUrl]: {
            status: 200,
            headers: { link: `<${commentsUrl}&page=2>; rel="next"` },
            body: [
              {
                id: 1,
                pull_request_review_id: 501,
                user: { login: 'Copilot' },
                created_at: '2026-09-01T00:05:00Z',
                path: 'src/a.ts',
                subject_type: 'line',
                line: null,
                original_line: 12,
                commit_id: 'sha6',
                original_commit_id: 'sha6',
                body: 'Consider handling the null case.',
              },
            ],
          },
          [`${commentsUrl}&page=2`]: {
            status: 200,
            body: [
              {
                id: 2,
                pull_request_review_id: 502,
                user: { login: 'alice' },
                created_at: '2026-09-01T01:00:00Z',
                path: 'src/a.ts',
                in_reply_to_id: 1,
                line: 14,
                original_line: 14,
                commit_id: 'sha7',
                original_commit_id: 'sha6',
              },
            ],
          },
        }),
      ),
    });

    const out = await enrichPullRequest(
      { db, provider },
      { workspaceId, repoId, repo, prNumber: 7, headSha: 'sha7' },
    );
    expect(out).toEqual({ reviews: 1, checks: 0, reviewComments: 2 });

    const rows = await db
      .select()
      .from(facts.prReviewComments)
      .where(eq(facts.prReviewComments.pullRequestId, prId))
      .orderBy(facts.prReviewComments.forgeCommentId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      forgeReviewId: '501',
      path: 'src/a.ts',
      subjectType: 'line',
      isReply: false,
      originalLine: 12,
      currentLine: null,
    });
    expect(rows[1]).toMatchObject({ isReply: true, currentLine: 14 });
    // Anchors only: the warehouse has no column that could hold the body.
    expect(JSON.stringify(rows)).not.toContain('null case');
    expect(await observedAt(prId)).toBeInstanceOf(Date);
    expect(await refusal(repoId)).toBeNull();

    // `Copilot` has no [bot] suffix; the registry still marks it a bot.
    const [copilot] = await db
      .select({ isBot: core.identities.isBot })
      .from(core.identities)
      .where(
        and(
          eq(core.identities.workspaceId, workspaceId),
          eq(core.identities.forgeLogin, 'Copilot'),
        ),
      );
    expect(copilot!.isBot).toBe(true);
  });

  it('GitHub: a refused comment fetch is recorded and leaves the PR unstamped', async () => {
    const repo = 'acme/refused';
    const { repoId, prId } = await makeRepoAndPr('refused', 8, 'sha8');
    const provider = new GitHubProvider({
      auth,
      client: clientOver(
        githubCanned(repo, 8, 'sha8', {
          [`${GH}/${repo}/pulls/8/comments?per_page=100`]: {
            status: 403,
            body: { message: 'Resource not accessible by integration' },
          },
        }),
      ),
    });
    const out = await enrichPullRequest(
      { db, provider },
      { workspaceId, repoId, repo, prNumber: 8, headSha: 'sha8' },
    );
    // The other fetches still landed.
    expect(out).toEqual({ reviews: 1, checks: 0, reviewComments: 0 });
    expect(await observedAt(prId)).toBeNull();
    expect(await refusal(repoId)).toMatch(/^review_comments not ingested — HTTP 403/);
  });

  it('Gitea: no comment fetch, no stamp, nothing recorded', async () => {
    const { repoId, prId } = await makeRepoAndPr('gitea', 9, 'sha9');
    const base = 'https://git.example.com';
    const api = `${base}/api/v1/repos/acme/gitea`;
    const provider = new GiteaProvider({
      auth,
      baseUrl: base,
      client: clientOver({
        [`${api}/pulls/9/reviews`]: { status: 200, body: [] },
        [`${api}/commits/sha9/statuses?page=1&limit=50`]: {
          status: 200,
          headers: { 'x-total-count': '0' },
          body: [],
        },
      }),
    });
    expect((provider as ForgeProvider).listReviewComments).toBeUndefined();
    const out = await enrichPullRequest(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/gitea', prNumber: 9, headSha: 'sha9' },
    );
    expect(out.reviewComments).toBe(0);
    expect(await observedAt(prId)).toBeNull();
    expect(await refusal(repoId)).toBeNull();
  });
});
