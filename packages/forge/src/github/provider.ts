import type { ForgeRequest, ForgeResponse } from '../client/budgeted-client.js';
import type { ForgeProvider } from '../provider.js';
import type {
  CallCtx,
  EndpointFamily,
  ForgeCapabilities,
  ForgeCheckRun,
  ForgeCommit,
  ForgeCursor,
  ForgeDeployment,
  ForgeDiffFile,
  ForgeFileContent,
  ForgeIssue,
  ForgePR,
  ForgeRelease,
  ForgeRepo,
  ForgeReview,
  Page,
  SinceQuery,
} from '../types.js';
import type { AuthHeaderProvider } from './auth.js';
import { listPullRequestsGraphql } from './graphql.js';
import { linkHeaderOf, nextPageCursor } from './pagination.js';
import { verifyWebhookSignature } from './webhook.js';
import {
  normalizeCheckRun,
  normalizeCommit,
  normalizeDeployment,
  normalizeDiffFile,
  normalizeFileContent,
  normalizeIssue,
  normalizePR,
  normalizeRelease,
  normalizeRepo,
  normalizeReview,
  type RawCheckRun,
  type RawCommit,
  type RawDeployment,
  type RawDiffFile,
  type RawFileContent,
  type RawIssue,
  type RawPR,
  type RawRelease,
  type RawRepo,
  type RawReview,
} from './normalize.js';

// GitHub's documented capability set (FORGE_PROVIDER §1). supportsRawDiff is
// false on purpose — we never touch the raw-diff media type (406 risk / C1).
export const GITHUB_CAPABILITIES: ForgeCapabilities = {
  supportsGraphQLBackfill: true,
  supportsDeployments: true,
  supportsCheckRuns: true,
  supportsStatsEndpoints: true,
  supportsRawDiff: false,
  reportsTotalCounts: false,
  hasRateLimits: true,
  maxPerPage: 100,
};

// The provider depends only on "something that runs a budgeted forge request"
// — BudgetedClient satisfies this structurally. Decoupling from the concrete
// class lets contract tests inject an in-memory client (no Postgres, no
// network) while prod passes a real BudgetedClient (Law 7 still holds — prod
// always uses the budgeter).
export interface ForgeHttpClient {
  request(ctx: CallCtx, req: ForgeRequest): Promise<ForgeResponse>;
}

export interface GitHubProviderOptions {
  client: ForgeHttpClient;
  auth: AuthHeaderProvider;
  /** Override for tests / GHE-later; defaults to public GitHub. */
  baseUrl?: string;
}

function withPage(base: string, cursor?: ForgeCursor): string {
  return cursor
    ? `${base}${base.includes('?') ? '&' : '?'}page=${encodeURIComponent(cursor)}`
    : base;
}

export class GitHubProvider implements ForgeProvider {
  readonly kind = 'github' as const;
  readonly capabilities = GITHUB_CAPABILITIES;

  private readonly client: ForgeHttpClient;
  private readonly auth: AuthHeaderProvider;
  private readonly base: string;

  constructor(opts: GitHubProviderOptions) {
    this.client = opts.client;
    this.auth = opts.auth;
    this.base = opts.baseUrl ?? 'https://api.github.com';
  }

  private getHeaders = (): Promise<Record<string, string>> => this.auth.headers();

  private async get(ctx: CallCtx, url: string, family: EndpointFamily): Promise<ForgeResponse> {
    return this.client.request(ctx, { method: 'GET', url, family, getHeaders: this.getHeaders });
  }

  private pageOf<Raw, T>(res: ForgeResponse, map: (r: Raw) => T): Page<T> {
    const items = (Array.isArray(res.body) ? (res.body as Raw[]) : []).map(map);
    const next = nextPageCursor(linkHeaderOf(res.headers));
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async listRepos(ctx: CallCtx, cursor?: ForgeCursor): Promise<Page<ForgeRepo>> {
    // PAT/user path. App installations use /installation/repositories (wrapped
    // {repositories}); the connect flow (W2-01) handles installation repo
    // selection — this method covers the user-token dev path.
    const res = await this.get(
      ctx,
      withPage(`${this.base}/user/repos?per_page=100&sort=pushed&direction=desc`, cursor),
      'commits',
    );
    return this.pageOf<RawRepo, ForgeRepo>(res, normalizeRepo);
  }

  async getRepo(ctx: CallCtx, fullName: string): Promise<ForgeRepo> {
    const res = await this.get(ctx, `${this.base}/repos/${fullName}`, 'commits');
    return normalizeRepo(res.body as RawRepo);
  }

  async listCommits(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeCommit>> {
    let url = `${this.base}/repos/${repo}/commits?per_page=${q.perPage ?? 100}`;
    if (q.since) url += `&since=${encodeURIComponent(q.since)}`;
    const res = await this.get(ctx, withPage(url, q.cursor), 'commits');
    return this.pageOf<RawCommit, ForgeCommit>(res, normalizeCommit);
  }

  async getCommitFiles(
    ctx: CallCtx,
    repo: string,
    sha: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDiffFile> & { stats: { additions: number; deletions: number } }> {
    const res = await this.get(
      ctx,
      withPage(`${this.base}/repos/${repo}/commits/${sha}?per_page=100`, cursor),
      'commits',
    );
    const body = res.body as {
      files?: RawDiffFile[];
      stats?: { additions: number; deletions: number };
    };
    const items = (body.files ?? []).map(normalizeDiffFile);
    const next = nextPageCursor(linkHeaderOf(res.headers));
    return {
      items,
      ...(next ? { nextCursor: next } : {}),
      stats: body.stats ?? { additions: 0, deletions: 0 },
    };
  }

  async listPullRequests(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgePR>> {
    const [owner, name] = repo.split('/');
    const run = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
      const res = await this.client.request(ctx, {
        method: 'POST',
        url: `${this.base}/graphql`,
        family: 'graphql',
        getHeaders: this.getHeaders,
        body: { query, variables },
      });
      const payload = res.body as { data?: unknown; errors?: { message: string }[] };
      if (payload.errors?.length) {
        throw new Error(`graphql: ${payload.errors.map((e) => e.message).join('; ')}`);
      }
      return payload.data;
    };
    return listPullRequestsGraphql(run, owner ?? '', name ?? '', q.cursor);
  }

  async getPullRequest(ctx: CallCtx, repo: string, n: number): Promise<ForgePR> {
    const res = await this.get(ctx, `${this.base}/repos/${repo}/pulls/${n}`, 'pulls');
    return normalizePR(res.body as RawPR);
  }

  async getPullRequestFiles(
    ctx: CallCtx,
    repo: string,
    n: number,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDiffFile>> {
    const res = await this.get(
      ctx,
      withPage(`${this.base}/repos/${repo}/pulls/${n}/files?per_page=100`, cursor),
      'pull_files',
    );
    return this.pageOf<RawDiffFile, ForgeDiffFile>(res, normalizeDiffFile);
  }

  async listReviews(ctx: CallCtx, repo: string, n: number): Promise<ForgeReview[]> {
    const res = await this.get(
      ctx,
      `${this.base}/repos/${repo}/pulls/${n}/reviews?per_page=100`,
      'pulls',
    );
    const raw = Array.isArray(res.body) ? (res.body as RawReview[]) : [];
    return raw.map((r) => normalizeReview(r, n)).filter((r): r is ForgeReview => r !== null);
  }

  async listCheckRuns(
    ctx: CallCtx,
    repo: string,
    q: SinceQuery & { headSha?: string },
  ): Promise<Page<ForgeCheckRun>> {
    const ref = q.headSha ?? '';
    const res = await this.get(
      ctx,
      withPage(`${this.base}/repos/${repo}/commits/${ref}/check-runs?per_page=100`, q.cursor),
      'checks',
    );
    const body = res.body as { check_runs?: RawCheckRun[] };
    const items = (body.check_runs ?? []).map(normalizeCheckRun);
    const next = nextPageCursor(linkHeaderOf(res.headers));
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async listReleases(
    ctx: CallCtx,
    repo: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeRelease>> {
    const res = await this.get(
      ctx,
      withPage(`${this.base}/repos/${repo}/releases?per_page=100`, cursor),
      'releases',
    );
    return this.pageOf<RawRelease, ForgeRelease>(res, normalizeRelease);
  }

  async listDeployments(
    ctx: CallCtx,
    repo: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDeployment>> {
    const res = await this.get(
      ctx,
      withPage(`${this.base}/repos/${repo}/deployments?per_page=100`, cursor),
      'releases',
    );
    return this.pageOf<RawDeployment, ForgeDeployment>(res, (d) => normalizeDeployment(d));
  }

  async listIssues(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeIssue>> {
    let url = `${this.base}/repos/${repo}/issues?state=all&per_page=${q.perPage ?? 100}`;
    if (q.since) url += `&since=${encodeURIComponent(q.since)}`;
    const res = await this.get(ctx, withPage(url, q.cursor), 'issues');
    return this.pageOf<RawIssue, ForgeIssue>(res, normalizeIssue);
  }

  async getFileContent(
    ctx: CallCtx,
    repo: string,
    path: string,
    ref: string,
  ): Promise<ForgeFileContent> {
    const res = await this.get(
      ctx,
      `${this.base}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      'contents',
    );
    return normalizeFileContent(res.body as RawFileContent, ref);
  }

  async registerWebhook(
    ctx: CallCtx,
    repo: string,
    url: string,
    secret: string,
    events: string[],
  ): Promise<string> {
    const res = await this.client.request(ctx, {
      method: 'POST',
      url: `${this.base}/repos/${repo}/hooks`,
      family: 'commits',
      getHeaders: this.getHeaders,
      body: {
        name: 'web',
        active: true,
        events,
        config: { url, secret, content_type: 'json', insecure_ssl: '0' },
      },
    });
    const body = res.body as { id: number };
    return String(body.id);
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    return verifyWebhookSignature(rawBody, signatureHeader, secret);
  }
}
