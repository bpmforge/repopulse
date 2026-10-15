import { assertListOk } from '../client/errors.js';
import {
  resolveTarball,
  createFetchDownloader,
  type TarballDownloader,
} from '../client/tarball.js';
import type { ForgeRequest, ForgeResponse } from '../client/budgeted-client.js';
import type { ForgeProvider } from '../provider.js';
import type {
  CallCtx,
  EndpointFamily,
  ForgeCapabilities,
  ForgeCheckRun,
  ForgeCodeScanningAlert,
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
  ForgeReviewComment,
  ForgeTarball,
  Page,
  SinceQuery,
} from '../types.js';
import type { AuthHeaderProvider } from './auth.js';
import { listPullRequestsGraphql } from './graphql.js';
import { linkHeaderOf, nextPageCursor } from './pagination.js';
import { verifyWebhookSignature } from './webhook.js';
import {
  normalizeCheckRun,
  normalizeCodeScanningAlert,
  normalizeCommit,
  normalizeDeployment,
  normalizeDiffFile,
  normalizeFileContent,
  normalizeIssue,
  normalizePR,
  normalizeRelease,
  normalizeReviewComment,
  normalizeRepo,
  normalizeReview,
  type RawCheckRun,
  type RawCodeScanningAlert,
  type RawCommit,
  type RawDeployment,
  type RawDiffFile,
  type RawFileContent,
  type RawIssue,
  type RawPR,
  type RawRelease,
  type RawRepo,
  type RawReview,
  type RawReviewComment,
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
  supportsTarball: true, // /tarball/{sha} → 302 codeload (W8-03)
  maxPerPage: 100,
  webhookScheme: 'hub-signature',
  // W18-24. The ENDPOINT exists on every GitHub repository; whether this
  // installation may read it is a permission ("Code scanning alerts: Read",
  // security_events). The App requests it, but an installation that has not
  // re-approved the new permission answers 403. That is how the pull learns
  // it, and it reports it rather than reading it as zero alerts.
  supportsCodeScanningAlerts: true,
};

// The provider depends only on "something that runs a budgeted forge request"
// — BudgetedClient satisfies this structurally. Decoupling from the concrete
// class lets contract tests inject an in-memory client (no Postgres, no
// network) while prod passes a real BudgetedClient (Law 7 still holds — prod
// always uses the budgeter).
export interface ForgeHttpClient {
  request(ctx: CallCtx, req: ForgeRequest): Promise<ForgeResponse>;
}

/**
 * Public GitHub's API host. Exported because callers outside this package need
 * the same default when they construct a client (the worker builds one per
 * workspace), and the forge host is this package's business: validate-arch
 * rule 4 keeps the literal from being re-typed anywhere else, which is how two
 * copies of a default silently diverge.
 */
export const DEFAULT_GITHUB_BASE_URL = 'https://api.github.com';

export interface GitHubProviderOptions {
  client: ForgeHttpClient;
  auth: AuthHeaderProvider;
  /** Override for tests / GHE-later; defaults to public GitHub. */
  baseUrl?: string;
  /** W8-03: injected so tests never touch codeload; prod uses plain fetch. */
  tarballDownloader?: TarballDownloader;
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
  private readonly download: TarballDownloader;

  constructor(opts: GitHubProviderOptions) {
    this.client = opts.client;
    this.auth = opts.auth;
    this.base = opts.baseUrl ?? DEFAULT_GITHUB_BASE_URL;
    this.download = opts.tarballDownloader ?? createFetchDownloader();
  }

  private getHeaders = (): Promise<Record<string, string>> => this.auth.headers();

  private async get(ctx: CallCtx, url: string, family: EndpointFamily): Promise<ForgeResponse> {
    return this.client.request(ctx, { method: 'GET', url, family, getHeaders: this.getHeaders });
  }

  private pageOf<Raw, T>(
    res: ForgeResponse,
    map: (r: Raw) => T,
    // Every list passes this: an HTTP error must reject, not read as an empty
    // page (W17-35 backfill lists, W17-38 enrichment fetches).
    check?: { entity: string; emptyOn?: readonly number[] },
  ): Page<T> {
    if (check && assertListOk(res, check.entity, check.emptyOn) === 'empty') return { items: [] };
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
    return this.pageOf<RawRepo, ForgeRepo>(res, normalizeRepo, { entity: 'repos' });
  }

  async getRepo(ctx: CallCtx, fullName: string): Promise<ForgeRepo> {
    const res = await this.get(ctx, `${this.base}/repos/${fullName}`, 'commits');
    // An error body normalized into a repo would carry no feature flags and
    // read as "unknown" at best; say what happened instead (W17-39).
    assertListOk(res, 'repo');
    return normalizeRepo(res.body as RawRepo);
  }

  async listCommits(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeCommit>> {
    let url = `${this.base}/repos/${repo}/commits?per_page=${q.perPage ?? 100}`;
    if (q.since) url += `&since=${encodeURIComponent(q.since)}`;
    const res = await this.get(ctx, withPage(url, q.cursor), 'commits');
    // 409 "Git Repository is empty." — no commits yet, not a failure.
    return this.pageOf<RawCommit, ForgeCommit>(res, normalizeCommit, {
      entity: 'commits',
      emptyOn: [409],
    });
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
    assertListOk(res, 'commit_files');
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
      // A non-2xx here (401, a 403 without rate-limit headers) has no GraphQL
      // `errors` array; say what it was rather than failing on a missing `data`.
      assertListOk(res, 'prs');
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
    return this.pageOf<RawDiffFile, ForgeDiffFile>(res, normalizeDiffFile, { entity: 'pr_files' });
  }

  async listReviews(ctx: CallCtx, repo: string, n: number): Promise<ForgeReview[]> {
    const res = await this.get(
      ctx,
      `${this.base}/repos/${repo}/pulls/${n}/reviews?per_page=100`,
      'pulls',
    );
    assertListOk(res, 'reviews');
    const raw = Array.isArray(res.body) ? (res.body as RawReview[]) : [];
    return raw.map((r) => normalizeReview(r, n)).filter((r): r is ForgeReview => r !== null);
  }

  // W18-23. Same 'pulls' budget family as listReviews: GitHub meters both
  // under the pulls resource, and a separate family would let the AI-reviewer
  // fetch starve nothing while silently doubling what the bucket allows.
  async listReviewComments(
    ctx: CallCtx,
    repo: string,
    n: number,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeReviewComment>> {
    const res = await this.get(
      ctx,
      withPage(`${this.base}/repos/${repo}/pulls/${n}/comments?per_page=100`, cursor),
      'pulls',
    );
    return this.pageOf<RawReviewComment, ForgeReviewComment>(
      res,
      (c) => normalizeReviewComment(c, n),
      { entity: 'review_comments' },
    );
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
    assertListOk(res, 'checks');
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
    return this.pageOf<RawRelease, ForgeRelease>(res, normalizeRelease, { entity: 'releases' });
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
    return this.pageOf<RawDeployment, ForgeDeployment>(res, (d) => normalizeDeployment(d), {
      entity: 'deployments',
    });
  }

  async listIssues(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeIssue>> {
    let url = `${this.base}/repos/${repo}/issues?state=all&per_page=${q.perPage ?? 100}`;
    if (q.since) url += `&since=${encodeURIComponent(q.since)}`;
    const res = await this.get(ctx, withPage(url, q.cursor), 'issues');
    return this.pageOf<RawIssue, ForgeIssue>(res, normalizeIssue, { entity: 'issues' });
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

  /**
   * Source archive for one commit (W8-03, C1a). ONE core point, like any REST
   * GET — the download itself happens on codeload, which is not rate-limited
   * and which we deliberately reach without the forge token.
   */
  async getTarball(ctx: CallCtx, repo: string, sha: string): Promise<ForgeTarball> {
    const res = await this.client.request(ctx, {
      method: 'GET',
      url: `${this.base}/repos/${repo}/tarball/${sha}`,
      family: 'contents',
      cost: 1,
      getHeaders: this.getHeaders,
    });
    return resolveTarball({
      commitSha: sha,
      apiHost: new URL(this.base).hostname,
      status: res.status,
      headers: res.headers,
      body: res.body,
      download: this.download,
    });
  }

  /**
   * Open code-scanning alerts (W18-24). READ-ONLY: GET only, state=open, and
   * nothing here can dismiss, reopen or upload. Drawn from the `checks`
   * secondary bucket — it is CI output read about a repository, the same
   * family of cost — and every page is one budgeted core point.
   */
  async listCodeScanningAlerts(
    ctx: CallCtx,
    repo: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeCodeScanningAlert>> {
    const res = await this.get(
      ctx,
      withPage(`${this.base}/repos/${repo}/code-scanning/alerts?state=open&per_page=100`, cursor),
      'checks',
    );
    // No emptyOn: a 404 ("no analysis found") and a 403 (permission missing)
    // are both answers the caller must SAY, not zero alerts.
    return this.pageOf<RawCodeScanningAlert, ForgeCodeScanningAlert>(
      res,
      normalizeCodeScanningAlert,
      { entity: 'code_scanning_alerts' },
    );
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
