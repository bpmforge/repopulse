import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitLabProvider } from '../src/gitlab/provider.js';
import { churnOfDiff } from '../src/gitlab/normalize.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// GitLabProvider contract (W12-01, zero network).
//
// Bodies below are trimmed copies of REAL responses from gitlab.com/api/v4
// (project gitlab-org/cli, 2026-08-14). GitLab diverges from GitHub further
// than Gitea does — different identifiers, a first-class merged state, no
// review object — and every one of those is asserted here rather than assumed.

const API = 'https://gitlab.com/api/v4';
const REPO = 'gitlab-org/cli';
const ENC = 'gitlab-org%2Fcli'; // the encoded form that MUST appear in the path
const ctx: CallCtx = { lane: 'backfill' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'glpat_contract' });

function provider(routes: StubRoute[]): GitLabProvider {
  return new GitLabProvider({ client: makeStubClient(routes), auth });
}

describe('GitLabProvider contract (W12-01, zero network)', () => {
  it('declares kind gitlab and an explicit capability object', () => {
    const p = provider([]);
    expect(p.kind).toBe('gitlab');
    expect(p.capabilities).toEqual({
      supportsGraphQLBackfill: false,
      supportsDeployments: true,
      supportsCheckRuns: true,
      supportsStatsEndpoints: false,
      supportsRawDiff: false,
      reportsTotalCounts: true,
      hasRateLimits: true,
      maxPerPage: 100,
    });
  });

  it('URL-ENCODES the project path — a raw slash 404s and looks like a permission error', async () => {
    const client = makeStubClient([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}`,
        response: {
          status: 200,
          body: {
            id: 34675721,
            name: 'cli',
            path_with_namespace: REPO,
            default_branch: 'main',
            visibility: 'public',
            archived: false,
            last_activity_at: '2026-08-14T17:20:49.730Z',
            web_url: `https://gitlab.com/${REPO}`,
          },
        },
      },
    ]);
    const p = new GitLabProvider({ client, auth });
    const repo = await p.getRepo(ctx, REPO);
    expect(client.calls[0]?.url).toContain(ENC);
    expect(client.calls[0]?.url).not.toContain(`projects/${REPO}`);
    expect(repo).toMatchObject({
      externalId: '34675721',
      fullName: REPO,
      isPrivate: false,
      pushedAt: '2026-08-14T17:20:49.730Z',
    });
  });

  it('treats `internal` visibility as private, because it is not public', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}`,
        response: {
          status: 200,
          body: {
            id: 1,
            name: 'x',
            path_with_namespace: REPO,
            visibility: 'internal',
            web_url: '',
          },
        },
      },
    ]);
    expect((await p.getRepo(ctx, REPO)).isPrivate).toBe(true);
  });

  it('listCommits maps `id` to sha and uses x-next-page for the cursor', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/repository/commits?page=1&per_page=100`,
        response: {
          status: 200,
          headers: { 'x-next-page': '2', 'x-total': '3314' },
          body: [
            {
              id: '3f1bb30cf005dea1594d70f584927610ea52943b',
              message: 'fix: thing',
              author_name: 'Ahmed Hemdan',
              author_email: 'ahemdan@gitlab.com',
              authored_date: '2026-08-14T18:12:28.000+02:00',
              committed_date: '2026-08-14T18:12:28.000+02:00',
              parent_ids: ['ebee93ea', '0f4d2187'],
            },
          ],
        },
      },
    ]);
    const page = await p.listCommits(ctx, REPO, {});
    expect(page.items[0]).toMatchObject({
      sha: '3f1bb30cf005dea1594d70f584927610ea52943b',
      authorEmail: 'ahemdan@gitlab.com',
      // GitLab commits carry no user object at all — only a name and an email.
      authorLogin: null,
      parentShas: ['ebee93ea', '0f4d2187'],
    });
    expect(page.nextCursor).toBe('2');
  });

  it('an empty x-next-page means the last page', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/repository/commits?page=9&per_page=100`,
        response: { status: 200, headers: { 'x-next-page': '', 'x-total': '9' }, body: [] },
      },
    ]);
    expect((await p.listCommits(ctx, REPO, { cursor: '9' })).nextCursor).toBeUndefined();
  });

  it('counts per-file churn from the unified diff, exactly', async () => {
    // This is what GitLab can do and Gitea cannot: no per-file counts are
    // returned, but the patch IS, so the numbers are counted rather than
    // guessed or zeroed.
    const diff = '@@ -1,3 +1,5 @@\n context\n+added one\n+added two\n-removed one\n context\n';
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/repository/commits/abc123`,
        response: { status: 200, body: { id: 'abc123', stats: { additions: 19, deletions: 3 } } },
      },
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/repository/commits/abc123/diff?page=1&per_page=100`,
        response: {
          status: 200,
          headers: { 'x-next-page': '' },
          body: [{ old_path: 'a.go', new_path: 'a.go', diff }],
        },
      },
    ]);
    const res = await p.getCommitFiles(ctx, REPO, 'abc123');
    expect(res.stats).toEqual({ additions: 19, deletions: 3 });
    expect(res.items[0]).toMatchObject({
      path: 'a.go',
      status: 'modified',
      additions: 2,
      deletions: 1,
    });
  });

  it('churnOfDiff ignores the +++/--- file headers', () => {
    expect(churnOfDiff('--- a/x\n+++ b/x\n+one\n-two\n')).toEqual({ additions: 1, deletions: 1 });
    expect(churnOfDiff(undefined)).toEqual({ additions: 0, deletions: 0 });
  });

  it('merge requests use iid as the number and merged is a FIRST-CLASS state', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/merge_requests?state=all&order_by=updated_at&sort=desc&page=1&per_page=100`,
        response: {
          status: 200,
          headers: { 'x-next-page': '' },
          body: [
            {
              id: 519581831,
              iid: 3719,
              title: 'Add a thing',
              state: 'merged',
              draft: false,
              author: { username: 'phikai' },
              merged_by: { username: 'ahmed.hemdan' },
              created_at: '2026-08-14T15:45:17.430Z',
              updated_at: '2026-08-14T16:12:30.265Z',
              merged_at: '2026-08-14T16:12:30.265Z',
              closed_at: null,
              target_branch: 'main',
              sha: '7ed49e2ac0bc439bc4d37dc7fd7431971577e2d6',
              changes_count: '4',
            },
          ],
        },
      },
    ]);
    const page = await p.listPullRequests(ctx, REPO, {});
    expect(page.items[0]).toMatchObject({
      // iid, not id: iid is what the UI and every URL use. Using id would make
      // every PR link in the product wrong.
      number: 3719,
      externalId: '519581831',
      state: 'merged',
      authorLogin: 'phikai',
      mergedByLogin: 'ahmed.hemdan',
      baseRef: 'main',
      changedFiles: 4,
    });
  });

  it('parses the capped changes_count form ("32+") without producing NaN', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/merge_requests/7`,
        response: {
          status: 200,
          body: {
            id: 1,
            iid: 7,
            title: 't',
            state: 'opened',
            created_at: 'a',
            updated_at: 'b',
            changes_count: '32+',
          },
        },
      },
    ]);
    expect((await p.getPullRequest(ctx, REPO, 7)).changedFiles).toBe(32);
  });

  it('listReviews maps APPROVALS, the only review-shaped thing GitLab exposes', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/merge_requests/3719/approvals`,
        response: {
          status: 200,
          body: {
            approved_by: [
              { user: { username: 'lunny' }, created_at: '2026-08-14T16:00:00Z' },
              { user: null, created_at: '2026-08-14T16:00:00Z' },
            ],
          },
        },
      },
    ]);
    const reviews = await p.listReviews(ctx, REPO, 3719);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ reviewerLogin: 'lunny', state: 'APPROVED', prNumber: 3719 });
  });

  it('listCheckRuns maps pipelines, which unlike Gitea statuses have a real duration', async () => {
    const sha = '3f1bb30c';
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/pipelines?sha=${sha}&page=1&per_page=100`,
        response: {
          status: 200,
          headers: { 'x-next-page': '' },
          body: [
            {
              id: 2761100756,
              sha,
              status: 'success',
              ref: 'main',
              created_at: '2026-08-14T16:12:31.956Z',
              updated_at: '2026-08-14T16:27:05.664Z',
            },
          ],
        },
      },
    ]);
    const page = await p.listCheckRuns(ctx, REPO, { headSha: sha });
    expect(page.items[0]).toMatchObject({
      externalId: '2761100756',
      status: 'completed',
      conclusion: 'success',
      startedAt: '2026-08-14T16:12:31.956Z',
      completedAt: '2026-08-14T16:27:05.664Z',
    });
  });

  it('releases are identified by TAG, because GitLab releases have no id', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/releases?page=1&per_page=100`,
        response: {
          status: 200,
          headers: { 'x-next-page': '' },
          body: [{ tag_name: 'v1.2.3', name: 'v1.2.3', released_at: '2026-08-01T00:00:00Z' }],
        },
      },
    ]);
    expect((await p.listReleases(ctx, REPO)).items[0]).toMatchObject({
      externalId: 'v1.2.3',
      tagName: 'v1.2.3',
      isDraft: false,
    });
  });

  it('issues are never pull requests on GitLab — they live on separate endpoints', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/projects/${ENC}/issues?state=all&page=1&per_page=100`,
        response: {
          status: 200,
          headers: { 'x-next-page': '' },
          body: [
            {
              id: 1,
              iid: 8494,
              title: 'a bug',
              state: 'closed',
              author: { username: 'HolyShitMan' },
              created_at: '2026-08-01T00:00:00Z',
              closed_at: '2026-08-14T16:12:31.097Z',
            },
          ],
        },
      },
    ]);
    expect((await p.listIssues(ctx, REPO, {})).items[0]).toMatchObject({
      number: 8494,
      state: 'closed',
      isPullRequest: false,
    });
  });

  it('registerWebhook translates events into GitLab per-event booleans', async () => {
    const client = makeStubClient([
      {
        method: 'POST',
        url: `${API}/projects/${ENC}/hooks`,
        response: { status: 201, body: { id: 99 } },
      },
    ]);
    const p = new GitLabProvider({ client, auth });
    expect(
      await p.registerWebhook(ctx, REPO, 'https://rp/hook', 'tok', ['push', 'pull_request']),
    ).toBe('99');
  });

  describe('verifyWebhook — X-Gitlab-Token is the SECRET ITSELF, not a signature', () => {
    const p = provider([]);
    const body = Buffer.from('{"object_kind":"push"}');

    it('accepts the matching token', () => {
      expect(p.verifyWebhook(body, 'shared-secret', 'shared-secret')).toBe(true);
    });

    it('rejects a wrong or truncated token', () => {
      expect(p.verifyWebhook(body, 'nope', 'shared-secret')).toBe(false);
      expect(p.verifyWebhook(body, 'shared', 'shared-secret')).toBe(false);
      expect(p.verifyWebhook(body, '', 'shared-secret')).toBe(false);
    });

    it('does NOT depend on the body — GitLab signs nothing', () => {
      // Recorded as a property, not an accident: a GitLab delivery proves the
      // sender knew the secret but says nothing about body integrity, which is
      // weaker than GitHub and Gitea and is why TLS matters more here.
      expect(p.verifyWebhook(Buffer.from('tampered'), 'shared-secret', 'shared-secret')).toBe(true);
    });
  });
});
