import type { ForgePR } from '../types.js';
import type { Page } from '../types.js';

// GraphQL backfill for PR metadata (research §6, FORGE_PROVIDER §4): one query
// per 50 PRs (~2 points) yields the additions/deletions/changedFiles that the
// REST list endpoint omits. Reviews/patches are fetched separately (REST) — the
// ForgeProvider interface returns Page<ForgePR>, so nested-review fetching is
// left to listReviews rather than overloading this return shape.

export const LIST_PULL_REQUESTS_QUERY = `query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(first:50,orderBy:{field:UPDATED_AT,direction:DESC},after:$cursor,states:[OPEN,CLOSED,MERGED]){
      pageInfo{hasNextPage endCursor}
      nodes{
        number id title body isDraft state
        createdAt updatedAt mergedAt closedAt
        author{login __typename}
        mergedBy{login}
        baseRefName headRefOid headRefName
        additions deletions changedFiles
      }
    }
  }
}`;

interface GqlPrNode {
  number: number;
  id: string;
  title: string;
  body: string | null;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author: { login: string; __typename: string } | null;
  mergedBy: { login: string } | null;
  baseRefName: string;
  headRefOid: string;
  headRefName?: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

interface ListPullRequestsData {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GqlPrNode[];
    };
  } | null;
}

function normalizeGqlPr(n: GqlPrNode): ForgePR {
  const state: ForgePR['state'] =
    n.state === 'MERGED' ? 'merged' : n.state === 'OPEN' ? 'open' : 'closed';
  return {
    number: n.number,
    externalId: n.id,
    title: n.title,
    body: n.body,
    authorLogin: n.author?.login ?? '',
    isBot: n.author?.__typename === 'Bot' || (n.author?.login?.endsWith('[bot]') ?? false),
    isDraft: n.isDraft,
    state,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    mergedAt: n.mergedAt,
    closedAt: n.closedAt,
    mergedByLogin: n.mergedBy?.login ?? null,
    baseRef: n.baseRefName,
    headSha: n.headRefOid,
    ...(n.headRefName ? { headRef: n.headRefName } : {}),
    additions: n.additions,
    deletions: n.deletions,
    changedFiles: n.changedFiles,
  };
}

export type GraphqlRunner = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

export async function listPullRequestsGraphql(
  run: GraphqlRunner,
  owner: string,
  name: string,
  cursor?: string,
): Promise<Page<ForgePR>> {
  const data = (await run(LIST_PULL_REQUESTS_QUERY, {
    owner,
    name,
    cursor: cursor ?? null,
  })) as ListPullRequestsData | undefined;

  // A runner that yields no `data` at all means the endpoint did not answer as
  // GraphQL (a 404, an HTML error page, a proxy). That is a broken endpoint,
  // not an empty repo, so it must throw rather than read as "no PRs" — but it
  // used to throw a bare TypeError on `data.repository`, which said nothing
  // about the cause. `repository: null` is different and stays an empty page:
  // GraphQL returns that for a repo the token genuinely cannot see.
  if (!data || typeof data !== 'object' || !('repository' in data)) {
    throw new Error(
      `graphql: response had no 'data.repository' — endpoint did not answer as GraphQL (${owner}/${name})`,
    );
  }

  const conn = data.repository?.pullRequests;
  if (!conn) return { items: [] };
  const items = conn.nodes.map(normalizeGqlPr);
  return {
    items,
    ...(conn.pageInfo.hasNextPage && conn.pageInfo.endCursor
      ? { nextCursor: conn.pageInfo.endCursor }
      : {}),
  };
}
