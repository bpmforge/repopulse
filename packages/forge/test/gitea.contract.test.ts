import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GiteaProvider } from '../src/gitea/provider.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// GiteaProvider contract (W7-02, FR-FORGE-7, zero network).
//
// The same contract the GitHub adapter is held to, against Gitea's shapes.
// Every response body below is a trimmed copy of a REAL response from a live
// Gitea v1 instance (gitea.com/api/v1, 2026-08-14) — not invented, and not
// copied from the swagger, because the three differences that mattered
// (missing pushed_at, no per-file commit churn, x-total-count) are all things
// the swagger does not make obvious.

const HOST = 'https://git.example.com';
const API = `${HOST}/api/v1`;
const REPO = 'acme/widgets';
const ctx: CallCtx = { lane: 'backfill' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'gitea_contract_test' });

function provider(routes: StubRoute[]): GiteaProvider {
  return new GiteaProvider({ client: makeStubClient(routes), auth, baseUrl: HOST });
}

const REPO_BODY = {
  id: 550,
  name: 'widgets',
  full_name: REPO,
  default_branch: 'main',
  private: false,
  archived: false,
  updated_at: '2026-08-06T05:06:13Z',
  html_url: `${HOST}/${REPO}`,
};

const COMMIT_BODY = {
  sha: '12726f4c9b68e74940dbd514e0acb83e236e7261',
  commit: {
    message: 'fix the widget',
    author: { name: 'silverwind', email: 'me@silverwind.io', date: '2026-08-05T22:50:47Z' },
    committer: { name: 'silverwind', email: 'me@silverwind.io', date: '2026-08-05T22:51:00Z' },
  },
  author: { login: 'silverwind' },
  parents: [{ sha: 'f34697c5ed65928e265d6f48e16928819ce0f332' }],
  stats: { total: 17, additions: 13, deletions: 4 },
  files: [{ filename: '.gitea/workflows/release.yml', status: 'modified' }],
};

describe('GiteaProvider contract (W7-02, zero network)', () => {
  it('capabilities match FORGE_PROVIDER §5 exactly', () => {
    const p = provider([]);
    expect(p.kind).toBe('gitea');
    expect(p.capabilities).toEqual({
      supportsGraphQLBackfill: false,
      supportsDeployments: false,
      supportsCheckRuns: false,
      supportsStatsEndpoints: false,
      supportsRawDiff: false,
      reportsTotalCounts: true,
      hasRateLimits: false,
      maxPerPage: 50,
    });
  });

  it('accepts a base URL with or without /api/v1', async () => {
    // An operator pastes whichever form their browser shows. Getting this wrong
    // produces 404s that look like a permissions problem.
    const routes = [
      { method: 'GET', url: `${API}/repos/${REPO}`, response: { status: 200, body: REPO_BODY } },
    ];
    for (const base of [HOST, `${HOST}/`, `${API}`, `${API}/`]) {
      const p = new GiteaProvider({ client: makeStubClient(routes), auth, baseUrl: base });
      expect((await p.getRepo(ctx, REPO)).fullName).toBe(REPO);
    }
  });

  it('getRepo maps updated_at to pushedAt (Gitea has no pushed_at)', async () => {
    const p = provider([
      { method: 'GET', url: `${API}/repos/${REPO}`, response: { status: 200, body: REPO_BODY } },
    ]);
    expect(await p.getRepo(ctx, REPO)).toMatchObject({
      externalId: '550',
      fullName: REPO,
      defaultBranch: 'main',
      isPrivate: false,
      isArchived: false,
      pushedAt: '2026-08-06T05:06:13Z',
    });
  });

  it('listCommits normalizes and uses x-total-count for the next cursor', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/commits?page=1&limit=50`,
        response: { status: 200, headers: { 'x-total-count': '699' }, body: [COMMIT_BODY] },
      },
    ]);
    const page = await p.listCommits(ctx, REPO, {});
    expect(page.items[0]).toMatchObject({
      sha: COMMIT_BODY.sha,
      authorLogin: 'silverwind',
      authorEmail: 'me@silverwind.io',
      parentShas: [COMMIT_BODY.parents[0]!.sha],
      stats: { additions: 13, deletions: 4 },
    });
    // 1 of 699 seen → there is a page 2.
    expect(page.nextCursor).toBe('2');
  });

  it('stops paginating once x-total-count is reached, without a wasted request', async () => {
    // The reason the cursor is derived from the total rather than "was the page
    // full": a full FINAL page is indistinguishable from a full middle one.
    const items = Array.from({ length: 50 }, (_, i) => ({ ...COMMIT_BODY, sha: `sha${i}` }));
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/commits?page=2&limit=50`,
        response: { status: 200, headers: { 'x-total-count': '100' }, body: items },
      },
    ]);
    const page = await p.listCommits(ctx, REPO, { cursor: '2' });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor, 'page 2 of 2 is the last page').toBeUndefined();
  });

  it('falls back to the full-page heuristic when x-total-count is absent', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ ...COMMIT_BODY, sha: `s${i}` }));
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/commits?page=1&limit=50`,
        response: { status: 200, body: items },
      },
    ]);
    expect((await p.listCommits(ctx, REPO, {})).nextCursor).toBe('2');
  });

  it('getCommitFiles is ONE call and carries accurate commit-level stats', async () => {
    const client = makeStubClient([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/git/commits/${COMMIT_BODY.sha}`,
        response: { status: 200, body: COMMIT_BODY },
      },
    ]);
    const p = new GiteaProvider({ client, auth, baseUrl: HOST });
    const res = await p.getCommitFiles(ctx, REPO, COMMIT_BODY.sha);

    expect(client.calls, 'commit detail embeds files — no second diff fetch').toHaveLength(1);
    expect(res.stats).toEqual({ additions: 13, deletions: 4 });
    expect(res.items[0]).toMatchObject({
      path: '.gitea/workflows/release.yml',
      status: 'modified',
    });
    // Gitea reports NO per-file churn on commits, on any endpoint. Zero is the
    // honest answer; splitting the commit total across files would be fiction.
    expect(res.items[0]?.additions).toBe(0);
    expect(res.items[0]?.deletions).toBe(0);
    expect(res.nextCursor, 'commit files are not paginated').toBeUndefined();
  });

  it('listPullRequests collapses merged into our three-state model', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/pulls?state=all&sort=recentupdate&page=1&limit=50`,
        response: {
          status: 200,
          headers: { 'x-total-count': '2' },
          body: [
            {
              id: 1,
              number: 1090,
              title: 'open one',
              state: 'open',
              merged: false,
              draft: false,
              user: { login: 'karoyqiu' },
              created_at: '2026-08-01T00:00:00Z',
              updated_at: '2026-08-02T00:00:00Z',
              base: { ref: 'main' },
              head: { sha: '9bd537c' },
              additions: null,
            },
            {
              id: 2,
              number: 1089,
              title: 'merged one',
              // Gitea reports a merged PR as state=closed + merged=true.
              state: 'closed',
              merged: true,
              merged_at: '2026-08-02T00:00:00Z',
              closed_at: '2026-08-02T00:00:00Z',
              merged_by: { login: 'lunny' },
              user: { login: 'karoyqiu' },
              created_at: '2026-08-01T00:00:00Z',
              updated_at: '2026-08-02T00:00:00Z',
              base: { ref: 'main' },
              head: { sha: 'abc1234' },
            },
          ],
        },
      },
    ]);
    const page = await p.listPullRequests(ctx, REPO, {});
    expect(page.items.map((x) => x.state)).toEqual(['open', 'merged']);
    expect(page.items[1]).toMatchObject({ mergedByLogin: 'lunny', baseRef: 'main' });
    // The LIST omits churn — verified live. It must be absent, not zero, or a
    // real 0-line PR becomes indistinguishable from an unfetched one.
    expect(page.items[0]?.additions).toBeUndefined();
  });

  it('getPullRequest fills the churn the list omits', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/pulls/1090`,
        response: {
          status: 200,
          body: {
            id: 1,
            number: 1090,
            title: 'detail',
            state: 'open',
            user: { login: 'karoyqiu' },
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-02T00:00:00Z',
            base: { ref: 'main' },
            head: { sha: '9bd537c' },
            additions: 233,
            deletions: 6,
            changed_files: 4,
          },
        },
      },
    ]);
    expect(await p.getPullRequest(ctx, REPO, 1090)).toMatchObject({
      additions: 233,
      deletions: 6,
      changedFiles: 4,
    });
  });

  it('getPullRequestFiles DOES carry per-file churn, unlike commit files', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/pulls/1090/files?page=1&limit=50`,
        response: {
          status: 200,
          headers: { 'x-total-count': '1' },
          body: [{ filename: 'cmd/api.go', status: 'changed', additions: 22, deletions: 1 }],
        },
      },
    ]);
    const page = await p.getPullRequestFiles(ctx, REPO, 1090);
    // 'changed' is Gitea's word for GitHub's 'modified'.
    expect(page.items[0]).toMatchObject({
      path: 'cmd/api.go',
      status: 'modified',
      additions: 22,
      deletions: 1,
    });
  });

  it('listReviews maps Gitea review states and drops ones we do not model', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/pulls/1090/reviews`,
        response: {
          status: 200,
          body: [
            {
              id: 288819,
              state: 'REQUEST_CHANGES',
              user: { login: 'lunny' },
              submitted_at: '2026-08-08T05:38:17Z',
            },
            {
              id: 288820,
              state: 'COMMENT',
              user: { login: 'silverwind' },
              submitted_at: '2026-08-08T06:00:00Z',
            },
            {
              id: 288821,
              state: 'APPROVED',
              user: { login: 'a' },
              submitted_at: '2026-08-08T07:00:00Z',
            },
            // PENDING is not a submitted review — it must not become one.
            { id: 288822, state: 'PENDING', user: { login: 'b' }, submitted_at: null },
          ],
        },
      },
    ]);
    const reviews = await p.listReviews(ctx, REPO, 1090);
    expect(reviews.map((r) => r.state)).toEqual(['CHANGES_REQUESTED', 'COMMENTED', 'APPROVED']);
    expect(reviews[0]?.prNumber).toBe(1090);
  });

  it('listCheckRuns returns commit STATUSES (Gitea has no check-runs API)', async () => {
    const sha = 'abc1234';
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/commits/${sha}/statuses?page=1&limit=50`,
        response: {
          status: 200,
          headers: { 'x-total-count': '1' },
          body: [
            {
              id: 6,
              status: 'success',
              context: 'goreleaser / release-image (push)',
              created_at: '2026-08-05T23:00:37Z',
              updated_at: '2026-08-05T23:00:37Z',
            },
          ],
        },
      },
    ]);
    const page = await p.listCheckRuns(ctx, REPO, { headSha: sha });
    expect(page.items[0]).toMatchObject({
      headSha: sha,
      name: 'goreleaser / release-image (push)',
      status: 'completed',
      conclusion: 'success',
      // A status has no start time, so CI DURATION cannot be derived from it.
      // Null rather than reusing created_at, which would fabricate a 0s run.
      startedAt: null,
    });
  });

  it('listCheckRuns with no head SHA asks the forge nothing', async () => {
    const client = makeStubClient([]);
    const p = new GiteaProvider({ client, auth, baseUrl: HOST });
    expect((await p.listCheckRuns(ctx, REPO, {})).items).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('listDeployments returns empty rather than throwing (capability is false)', async () => {
    const client = makeStubClient([]);
    const p = new GiteaProvider({ client, auth, baseUrl: HOST });
    // DORA deploy signal falls back to releases (FR-METRICS-12). Throwing here
    // would fail a backfill over a capability the caller was told about.
    expect((await p.listDeployments(ctx, REPO)).items).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('listIssues excludes pull requests', async () => {
    const p = provider([
      {
        method: 'GET',
        url: `${API}/repos/${REPO}/issues?state=all&type=issues&page=1&limit=50`,
        response: {
          status: 200,
          headers: { 'x-total-count': '1' },
          body: [
            {
              id: 7,
              number: 3,
              title: 'a bug',
              state: 'closed',
              user: { login: 'dev' },
              created_at: '2026-08-01T00:00:00Z',
              closed_at: '2026-08-03T00:00:00Z',
              pull_request: null,
            },
          ],
        },
      },
    ]);
    const page = await p.listIssues(ctx, REPO, {});
    expect(page.items[0]).toMatchObject({ number: 3, state: 'closed', isPullRequest: false });
  });

  it('registerWebhook nests the secret inside config, as Gitea requires', async () => {
    const client = makeStubClient([
      {
        method: 'POST',
        url: `${API}/repos/${REPO}/hooks`,
        response: { status: 201, body: { id: 4242 } },
      },
    ]);
    const p = new GiteaProvider({ client, auth, baseUrl: HOST });
    expect(await p.registerWebhook(ctx, REPO, 'https://rp.example/hook', 's3cret', ['push'])).toBe(
      '4242',
    );
  });

  describe('verifyWebhook — X-Gitea-Signature is a BARE hex digest', () => {
    const body = Buffer.from('{"action":"opened"}');
    const secret = 'whsec';
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    const p = provider([]);

    it('accepts the bare lowercase hex Gitea actually sends', () => {
      expect(p.verifyWebhook(body, digest, secret)).toBe(true);
    });

    it('rejects a GitHub-shaped sha256= prefix', () => {
      // Deliberately NOT tolerated: accepting both formats would mean a caller
      // could not tell which forge signed a delivery.
      expect(p.verifyWebhook(body, `sha256=${digest}`, secret)).toBe(false);
    });

    it('rejects a wrong secret, a truncated digest and an empty header', () => {
      expect(p.verifyWebhook(body, digest, 'wrong')).toBe(false);
      expect(p.verifyWebhook(body, digest.slice(0, 40), secret)).toBe(false);
      expect(p.verifyWebhook(body, '', secret)).toBe(false);
    });

    it('rejects a tampered body under the right secret', () => {
      expect(p.verifyWebhook(Buffer.from('{"action":"closed"}'), digest, secret)).toBe(false);
    });
  });
});
