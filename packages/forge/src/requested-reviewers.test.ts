import { describe, expect, it } from 'vitest';
import { listPullRequestsGraphql } from './github/graphql.js';
import { normalizePR as githubPR, type RawPR } from './github/normalize.js';
import { normalizePR as giteaPR, type RawGiteaPR } from './gitea/normalize.js';
import { normalizePR as gitlabPR, type RawGitlabMr } from './gitlab/normalize.js';

// W20-16 (UX_TODO DSH-85): who was asked to review, from every forge. Field
// names checked against each forge's own schema: GitHub REST
// `requested_reviewers` (@octokit/openapi-types pull-request), GitHub GraphQL
// `reviewRequests.nodes.requestedReviewer` (a Bot | Mannequin | Team | User
// union), Gitea `requested_reviewers` (modules/structs/pull.go) and GitLab
// `reviewers[].username` (doc/api/merge_requests.md).

const ghBase: RawPR = {
  number: 1,
  node_id: 'PR_1',
  title: 't',
  body: null,
  user: { login: 'dana' },
  state: 'open',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  merged_at: null,
  closed_at: null,
  base: { ref: 'main' },
  head: { sha: 'abc' },
};

describe('requested reviewers', () => {
  it('GitHub REST: users only, and absent stays absent', () => {
    expect(
      githubPR({ ...ghBase, requested_reviewers: [{ login: 'ana' }, null, { login: 'bo' }] })
        .requestedReviewerLogins,
    ).toEqual(['ana', 'bo']);
    expect(githubPR({ ...ghBase, requested_reviewers: [] }).requestedReviewerLogins).toEqual([]);
    expect('requestedReviewerLogins' in githubPR(ghBase)).toBe(false);
  });

  it('GitHub GraphQL: a team request names nobody and is dropped', async () => {
    const node = {
      number: 2,
      id: 'PR_2',
      title: 't',
      body: null,
      isDraft: false,
      state: 'OPEN' as const,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      mergedAt: null,
      closedAt: null,
      author: { login: 'dana', __typename: 'User' },
      mergedBy: null,
      baseRefName: 'main',
      headRefOid: 'abc',
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'ana' } },
          { requestedReviewer: { __typename: 'Team' } },
        ],
      },
    };
    const res = await listPullRequestsGraphql(
      async () => ({
        repository: {
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] },
        },
      }),
      'o',
      'r',
    );
    expect(res.items[0]?.requestedReviewerLogins).toEqual(['ana']);
  });

  it('Gitea and GitLab', () => {
    const gitea: RawGiteaPR = {
      id: 3,
      number: 3,
      title: 't',
      state: 'open',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      requested_reviewers: [{ login: 'ana' }],
    };
    expect(giteaPR(gitea).requestedReviewerLogins).toEqual(['ana']);
    const mr: RawGitlabMr = {
      id: 4,
      iid: 4,
      title: 't',
      state: 'opened',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      reviewers: [{ username: 'bo' }],
    };
    expect(gitlabPR(mr).requestedReviewerLogins).toEqual(['bo']);
  });
});
