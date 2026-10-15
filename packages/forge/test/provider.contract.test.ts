import { describe, expect, it } from 'vitest';
import { loadGithubFixtures } from '../fixtures/replay.js';
import type { Fixture } from '../fixtures/types.js';
import { createAppHeaderProvider, createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

const API = 'https://api.github.com';
const REPO = 'bpmforge/repopulse-fixture';
const ctx: CallCtx = { lane: 'backfill' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'ghp_contract_test' });

function provider(routes: StubRoute[]): GitHubProvider {
  return new GitHubProvider({ client: makeStubClient(routes), auth });
}

// A recorded W0-04 fixture, for the edge cases the acceptance names by fixture.
function recorded(scenario: string): Fixture {
  const fx = loadGithubFixtures().find((f) => f.scenario === scenario);
  if (!fx) throw new Error(`missing W0-04 fixture ${scenario}`);
  return fx;
}

describe('GitHubProvider contract (W1-06, zero network)', () => {
  it('capabilities match the documented GitHub set', () => {
    const p = provider([]);
    expect(p.kind).toBe('github');
    expect(p.capabilities).toMatchObject({
      supportsGraphQLBackfill: true,
      supportsDeployments: true,
      supportsRawDiff: false,
      maxPerPage: 100,
      webhookScheme: 'hub-signature',
    });
  });

  it('getRepo normalizes a repo', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}`,
        response: {
          status: 200,
          body: {
            id: 42,
            name: 'repopulse-fixture',
            full_name: REPO,
            default_branch: 'main',
            private: true,
            archived: false,
            pushed_at: '2026-07-18T00:00:00Z',
            html_url: `https://github.com/${REPO}`,
          },
        },
      },
    ]);
    expect(await p.getRepo(ctx, REPO)).toMatchObject({
      externalId: '42',
      fullName: REPO,
      defaultBranch: 'main',
      isPrivate: true,
    });
  });

  it('listCommits normalizes commits incl. a merge commit (>1 parent) + Link cursor', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/commits?per_page=100`,
        response: {
          status: 200,
          headers: {
            link: `<${API}/repos/${REPO}/commits?per_page=100&page=2>; rel="next"`,
          },
          body: [
            {
              sha: 'aaa',
              commit: {
                author: { name: 'A', email: 'a@x.com', date: '2026-01-01T00:00:00Z' },
                committer: { date: '2026-01-01T00:00:00Z' },
                message: 'feat',
              },
              author: { login: 'alice' },
              parents: [{ sha: 'p1' }],
            },
            {
              sha: 'mmm',
              commit: {
                author: { name: 'B', email: 'b@x.com', date: '2026-01-02T00:00:00Z' },
                committer: { date: '2026-01-02T00:00:00Z' },
                message: 'Merge',
              },
              author: null, // no matched login → email attribution
              parents: [{ sha: 'p1' }, { sha: 'p2' }],
            },
          ],
        },
      },
    ]);
    const page = await p.listCommits(ctx, REPO, {});
    expect(page.items[0]).toMatchObject({ sha: 'aaa', authorLogin: 'alice', parentShas: ['p1'] });
    expect(page.items[1]).toMatchObject({ authorLogin: null, authorEmail: 'b@x.com' });
    expect(page.items[1]?.parentShas).toHaveLength(2); // merge commit preserved
    expect(page.nextCursor).toBe('2');
  });

  it('getPullRequest maps merged_at → state:merged and fills counts', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/pulls/1`,
        response: {
          status: 200,
          body: {
            number: 1,
            node_id: 'PR_1',
            title: 'alpha',
            body: null,
            user: { login: 'alice', type: 'User' },
            draft: false,
            state: 'closed',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            merged_at: '2026-01-02T00:00:00Z',
            closed_at: '2026-01-02T00:00:00Z',
            merged_by: { login: 'bob' },
            base: { ref: 'main' },
            head: { sha: 'headsha' },
            additions: 10,
            deletions: 2,
            changed_files: 3,
          },
        },
      },
    ]);
    expect(await p.getPullRequest(ctx, REPO, 1)).toMatchObject({
      number: 1,
      state: 'merged',
      mergedByLogin: 'bob',
      additions: 10,
      changedFiles: 3,
      isBot: false,
    });
  });

  it('getPullRequestFiles sets patchTruncated on a real W0-04-recorded patch-less file', async () => {
    const fx = recorded('pull-files-truncated'); // repopulse PR #5, real
    const p = provider([{ method: 'GET', url: fx.request.url, response: fx.response }]);
    // fx.request.url is .../repos/bpmforge/repopulse/pulls/5/files?per_page=100
    const page = await p.getPullRequestFiles(ctx, 'bpmforge/repopulse', 5);
    expect(page.items.some((f) => f.patchTruncated)).toBe(true);
    expect(page.items.every((f) => (f.patchTruncated ? f.patch === undefined : true))).toBe(true);
  });

  it('listReviews drops PENDING drafts, keeps submitted reviews', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/pulls/2/reviews?per_page=100`,
        response: {
          status: 200,
          body: [
            {
              id: 1,
              user: { login: 'r1' },
              state: 'COMMENTED',
              submitted_at: '2026-01-01T00:00:00Z',
            },
            { id: 2, user: { login: 'r2' }, state: 'PENDING' },
          ],
        },
      },
    ]);
    const reviews = await p.listReviews(ctx, REPO, 2);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewerLogin: 'r1', state: 'COMMENTED', prNumber: 2 });
  });

  it('listReviewComments keeps the diff anchors and reads a null line as outdated', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/pulls/2/comments?per_page=100`,
        response: {
          status: 200,
          headers: {
            link: `<${API}/repos/${REPO}/pulls/2/comments?per_page=100&page=2>; rel="next"`,
          },
          body: [
            {
              id: 11,
              pull_request_review_id: 501,
              user: { login: 'coderabbitai[bot]' },
              created_at: '2026-01-01T00:00:00Z',
              path: 'src/a.ts',
              subject_type: 'line',
              start_line: null,
              original_start_line: 4,
              line: null,
              original_line: 6,
              commit_id: 'c1',
              original_commit_id: 'c1',
              body: 'never stored',
            },
            {
              id: 12,
              pull_request_review_id: 502,
              user: { login: 'alice' },
              created_at: '2026-01-01T01:00:00Z',
              path: 'src/a.ts',
              in_reply_to_id: 11,
              line: 9,
              original_line: 9,
              commit_id: 'c2',
              original_commit_id: 'c1',
            },
            {
              id: 13,
              pull_request_review_id: null,
              user: null,
              created_at: '2026-01-01T02:00:00Z',
              path: 'README.md',
              subject_type: 'file',
              commit_id: 'c2',
              original_commit_id: 'c2',
            },
          ],
        },
      },
    ]);
    const page = await p.listReviewComments(ctx, REPO, 2);
    expect(page.nextCursor).toBeDefined();
    expect(page.items).toHaveLength(3);
    expect(page.items[0]).toEqual({
      externalId: '11',
      prNumber: 2,
      reviewExternalId: '501',
      authorLogin: 'coderabbitai[bot]',
      createdAt: '2026-01-01T00:00:00Z',
      path: 'src/a.ts',
      subjectType: 'line',
      isReply: false,
      originalStartLine: 4,
      originalLine: 6,
      line: null,
      originalCommitSha: 'c1',
      commitSha: 'c1',
    });
    expect(page.items[0]).not.toHaveProperty('body');
    expect(page.items[1]).toMatchObject({ isReply: true, line: 9, subjectType: 'line' });
    expect(page.items[2]).toMatchObject({
      subjectType: 'file',
      originalLine: null,
      authorLogin: '',
      reviewExternalId: null,
    });
  });

  it('listReviewComments rejects an HTTP error instead of reading it as no comments', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/pulls/2/comments?per_page=100`,
        response: { status: 403, body: { message: 'Resource not accessible by integration' } },
      },
    ]);
    await expect(p.listReviewComments(ctx, REPO, 2)).rejects.toThrow();
  });

  it('listCheckRuns unwraps {check_runs}', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/commits/headsha/check-runs?per_page=100`,
        response: {
          status: 200,
          body: {
            total_count: 1,
            check_runs: [
              {
                id: 9,
                head_sha: 'headsha',
                name: 'build',
                status: 'completed',
                conclusion: 'failure',
                started_at: '2026-01-01T00:00:00Z',
                completed_at: '2026-01-01T00:01:00Z',
              },
            ],
          },
        },
      },
    ]);
    const page = await p.listCheckRuns(ctx, REPO, { headSha: 'headsha' });
    expect(page.items[0]).toMatchObject({
      name: 'build',
      conclusion: 'failure',
      headSha: 'headsha',
    });
  });

  it('listIssues flags PRs via the pull_request key', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/issues?state=all&per_page=100`,
        response: {
          status: 200,
          body: [
            {
              id: 1,
              number: 4,
              title: 'bug',
              user: { login: 'u' },
              state: 'open',
              created_at: '2026-01-01T00:00:00Z',
              closed_at: null,
            },
            {
              id: 2,
              number: 1,
              title: 'a PR',
              user: { login: 'u' },
              state: 'closed',
              created_at: '2026-01-01T00:00:00Z',
              closed_at: '2026-01-02T00:00:00Z',
              pull_request: { url: 'x' },
            },
          ],
        },
      },
    ]);
    const page = await p.listIssues(ctx, REPO, {});
    expect(page.items[0]?.isPullRequest).toBe(false);
    expect(page.items[1]?.isPullRequest).toBe(true);
  });

  it('listReleases + listDeployments normalize', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/releases?per_page=100`,
        response: {
          status: 200,
          body: [
            {
              id: 3,
              tag_name: 'v0.1.0',
              name: 'v0.1.0',
              draft: false,
              prerelease: false,
              published_at: '2026-01-01T00:00:00Z',
            },
          ],
        },
      },
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/deployments?per_page=100`,
        response: {
          status: 200,
          body: [
            { id: 7, sha: 'depsha', environment: 'production', created_at: '2026-01-01T00:00:00Z' },
          ],
        },
      },
    ]);
    expect((await p.listReleases(ctx, REPO)).items[0]).toMatchObject({ tagName: 'v0.1.0' });
    expect((await p.listDeployments(ctx, REPO)).items[0]).toMatchObject({
      environment: 'production',
      latestStatus: null,
    });
  });

  it('getFileContent marks >1MB (content:null) as truncated', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/contents/big.bin?ref=main`,
        response: { status: 200, body: { path: 'big.bin', size: 2_000_000, content: null } },
      },
    ]);
    expect(await p.getFileContent(ctx, REPO, 'big.bin', 'main')).toMatchObject({
      truncated: true,
      content: null,
    });
  });

  it('listPullRequests uses GraphQL (POST /graphql, body seam) and normalizes nodes', async () => {
    const p = provider([
      {
        method: 'POST',
        url: `${API}/graphql`,
        bodyIncludes: 'pullRequests',
        response: {
          status: 200,
          body: {
            data: {
              repository: {
                pullRequests: {
                  pageInfo: { hasNextPage: true, endCursor: 'CUR2' },
                  nodes: [
                    {
                      number: 1,
                      id: 'PR_1',
                      title: 'alpha',
                      body: null,
                      isDraft: false,
                      state: 'MERGED',
                      createdAt: '2026-01-01T00:00:00Z',
                      updatedAt: '2026-01-02T00:00:00Z',
                      mergedAt: '2026-01-02T00:00:00Z',
                      closedAt: '2026-01-02T00:00:00Z',
                      author: { login: 'alice', __typename: 'User' },
                      mergedBy: { login: 'bob' },
                      baseRefName: 'main',
                      headRefOid: 'headsha',
                      additions: 10,
                      deletions: 2,
                      changedFiles: 3,
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ]);
    const page = await p.listPullRequests(ctx, REPO, {});
    expect(page.items[0]).toMatchObject({ number: 1, state: 'merged', changedFiles: 3 });
    expect(page.nextCursor).toBe('CUR2'); // GraphQL endCursor, not a page number
  });

  it('registerWebhook POSTs the hook config (body seam) and returns the hook id', async () => {
    const client = makeStubClient([
      {
        method: 'POST',
        url: `${API}/repos/${REPO}/hooks`,
        response: { status: 201, body: { id: 123456 } },
      },
    ]);
    const p = new GitHubProvider({ client, auth });
    const id = await p.registerWebhook(ctx, REPO, 'https://hook', 'sekret', ['pull_request']);
    expect(id).toBe('123456');
    expect(client.calls[0]?.method).toBe('POST');
  });

  it('an unrouted call throws (no live github.com escape)', async () => {
    const p = provider([]);
    await expect(p.getRepo(ctx, 'acme/nope')).rejects.toThrow(/would hit network/);
  });

  const repoRoute: StubRoute = {
    method: 'GET',
    url: `${API}/repos/${REPO}`,
    response: {
      status: 200,
      body: {
        id: 1,
        name: 'repopulse-fixture',
        full_name: REPO,
        default_branch: 'main',
        private: true,
        archived: false,
        pushed_at: null,
        html_url: `https://github.com/${REPO}`,
      },
    },
  };

  it('PAT auth: the request carries the PAT as a Bearer token (FR-FORGE-5)', async () => {
    const client = makeStubClient([repoRoute]);
    const p = new GitHubProvider({ client, auth });
    await p.getRepo(ctx, REPO);
    expect(client.calls[0]?.headers.authorization).toBe('Bearer ghp_contract_test');
  });

  it('App auth: the request carries the installation token, listing a private repo (FR-FORGE-5)', async () => {
    // Hand-authored installation token (the JWT→access_token exchange fixture
    // flagged in the W0-05 split — an App token can't be recorded live without a
    // registered App). The auth lifecycle itself is covered in auth.test.ts.
    const appAuth = createAppHeaderProvider({
      mintInstallationToken: () =>
        Promise.resolve({ token: 'ghs_installation_token', expiresAtMs: Date.now() + 3_600_000 }),
    });
    const client = makeStubClient([repoRoute]);
    const p = new GitHubProvider({ client, auth: appAuth });
    const repo = await p.getRepo(ctx, REPO);
    expect(repo.isPrivate).toBe(true); // listed a private repo
    expect(client.calls[0]?.headers.authorization).toBe('Bearer ghs_installation_token');
  });
});
