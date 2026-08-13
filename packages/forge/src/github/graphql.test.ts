import { describe, expect, it } from 'vitest';
import { listPullRequestsGraphql } from './graphql.js';

// Regression cover for the W12-03 ingestion failure: the e2e fake served REST
// but not POST /graphql, so the runner returned undefined and PR backfill died
// on "Cannot read properties of undefined (reading 'repository')" — an error
// that named neither GraphQL nor the endpoint.

const node = (number: number) => ({
  number,
  id: `gql-pr-${number}`,
  title: `PR ${number}`,
  body: null,
  isDraft: false,
  state: 'MERGED' as const,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  mergedAt: '2026-08-02T00:00:00.000Z',
  closedAt: '2026-08-02T00:00:00.000Z',
  author: { login: 'fixture-dev', __typename: 'User' },
  mergedBy: { login: 'fixture-dev' },
  baseRefName: 'main',
  headRefOid: `head-${number}`,
  additions: 20,
  deletions: 4,
  changedFiles: 2,
});

const page = (
  nodes: ReturnType<typeof node>[],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({
  repository: { pullRequests: { pageInfo: { hasNextPage, endCursor }, nodes } },
});

describe('listPullRequestsGraphql', () => {
  it('normalizes a MERGED PR into the ForgePR shape', async () => {
    const res = await listPullRequestsGraphql(async () => page([node(11)]), 'fixture-org', 'alpha');
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      number: 11,
      state: 'merged',
      authorLogin: 'fixture-dev',
      mergedByLogin: 'fixture-dev',
      baseRef: 'main',
      changedFiles: 2,
      isBot: false,
    });
    expect(res.nextCursor).toBeUndefined();
  });

  it('surfaces a next cursor only when there is another page', async () => {
    const res = await listPullRequestsGraphql(
      async () => page([node(11)], true, 'CURSOR2'),
      'fixture-org',
      'alpha',
    );
    expect(res.nextCursor).toBe('CURSOR2');
  });

  it('flags a Bot author', async () => {
    const bot = { ...node(12), author: { login: 'dependabot[bot]', __typename: 'Bot' } };
    const res = await listPullRequestsGraphql(async () => page([bot]), 'fixture-org', 'alpha');
    expect(res.items[0]?.isBot).toBe(true);
  });

  it('treats repository:null as an empty page (token cannot see the repo)', async () => {
    const res = await listPullRequestsGraphql(
      async () => ({ repository: null }),
      'fixture-org',
      'alpha',
    );
    expect(res.items).toEqual([]);
  });

  it('THROWS a diagnosable error when the endpoint returned no data at all', async () => {
    // The 404-served-as-JSON case. It must not read as "no PRs" — a broken
    // endpoint and an empty repo are different facts, and conflating them is
    // how ingestion completed while writing nothing.
    await expect(
      listPullRequestsGraphql(async () => undefined, 'fixture-org', 'alpha'),
    ).rejects.toThrow(/no 'data.repository'.*fixture-org\/alpha/);
  });
});
