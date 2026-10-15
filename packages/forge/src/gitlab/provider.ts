import { assertListOk } from '../client/errors.js';
import type { ForgeResponse } from '../client/budgeted-client.js';
import type { ForgeHttpClient } from '../github/provider.js';
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
  ForgeTarball,
  Page,
  SinceQuery,
} from '../types.js';
import type { AuthHeaderProvider } from '../github/auth.js';
import {
  GITLAB_MAX_PER_PAGE,
  nextPageCursor,
  pageOfCursor,
  projectPath,
  withPage,
} from './pagination.js';
import { verifyWebhookToken } from './webhook.js';
import {
  normalizeApproval,
  normalizeCommit,
  normalizeDiff,
  normalizeFileContent,
  normalizeIssue,
  normalizePR,
  normalizePipeline,
  normalizeRelease,
  normalizeRepo,
  type RawGitlabApproval,
  type RawGitlabCommit,
  type RawGitlabDiff,
  type RawGitlabFile,
  type RawGitlabIssue,
  type RawGitlabMr,
  type RawGitlabPipeline,
  type RawGitlabProject,
  type RawGitlabRelease,
} from './normalize.js';

// GitLabProvider (W12-01, D3a). Verified against gitlab.com/api/v4 on
// 2026-08-14 — see normalize.ts for where GitLab genuinely differs.

export const GITLAB_CAPABILITIES: ForgeCapabilities = {
  supportsGraphQLBackfill: false, // GitLab has GraphQL, but the REST walk is what we implement
  supportsDeployments: true, // real deployments API, unlike Gitea
  supportsCheckRuns: true, // pipelines, with genuine start/end times
  supportsStatsEndpoints: false,
  supportsRawDiff: false, // diffs come through the JSON API, never a raw patch endpoint
  reportsTotalCounts: true, // x-total
  hasRateLimits: true, // gitlab.com enforces limits; self-managed usually does too
  // False on purpose (W8-03): GitLab's archive endpoint has not been verified
  // against a live instance the way the rest of this adapter was, and a
  // capability that claims an unverified op is worse than one that says no —
  // callers branch on this flag and will simply skip snapshot scanners.
  supportsTarball: false,
  maxPerPage: GITLAB_MAX_PER_PAGE,
  webhookScheme: 'gitlab-token',
  // W18-24: not supported yet — GitLab's vulnerability report is a different API, not read yet. Teams here upload SARIF instead.
  supportsCodeScanningAlerts: false,
};

export interface GitLabProviderOptions {
  client: ForgeHttpClient;
  auth: AuthHeaderProvider;
  /** gitlab.com or a self-managed instance. */
  baseUrl?: string;
}

export class GitLabProvider implements ForgeProvider {
  readonly kind = 'gitlab' as const;
  readonly capabilities = GITLAB_CAPABILITIES;

  private readonly client: ForgeHttpClient;
  private readonly auth: AuthHeaderProvider;
  private readonly base: string;

  constructor(opts: GitLabProviderOptions) {
    this.client = opts.client;
    this.auth = opts.auth;
    const trimmed = (opts.baseUrl ?? 'https://gitlab.com').replace(/\/+$/, '');
    this.base = trimmed.endsWith('/api/v4') ? trimmed : `${trimmed}/api/v4`;
  }

  private getHeaders = (): Promise<Record<string, string>> => this.auth.headers();

  private async get(ctx: CallCtx, url: string, family: EndpointFamily): Promise<ForgeResponse> {
    return this.client.request(ctx, { method: 'GET', url, family, getHeaders: this.getHeaders });
  }

  /** One paginated GET. GitLab states the next page outright in a header. */
  private async paged<Raw, T>(
    ctx: CallCtx,
    baseUrl: string,
    cursor: ForgeCursor | undefined,
    family: EndpointFamily,
    map: (r: Raw) => T,
    perPage = GITLAB_MAX_PER_PAGE,
    // Every list passes this: an HTTP error must reject, not read as an empty
    // page (W17-35 backfill lists, W17-38 enrichment fetches).
    check?: { entity: string; emptyOn?: readonly number[] },
  ): Promise<Page<T>> {
    const res = await this.get(ctx, withPage(baseUrl, pageOfCursor(cursor), perPage), family);
    if (check && assertListOk(res, check.entity, check.emptyOn) === 'empty') return { items: [] };
    const raw = Array.isArray(res.body) ? (res.body as Raw[]) : [];
    const next = nextPageCursor(res.headers);
    return { items: raw.map(map), ...(next ? { nextCursor: next } : {}) };
  }

  async listRepos(ctx: CallCtx, cursor?: ForgeCursor): Promise<Page<ForgeRepo>> {
    // membership=true scopes to projects this token can actually act on, which
    // is the GitLab equivalent of GitHub's /user/repos.
    return this.paged<RawGitlabProject, ForgeRepo>(
      ctx,
      `${this.base}/projects?membership=true&order_by=last_activity_at&sort=desc`,
      cursor,
      'commits',
      normalizeRepo,
      undefined,
      { entity: 'repos' },
    );
  }

  async getRepo(ctx: CallCtx, fullName: string): Promise<ForgeRepo> {
    const res = await this.get(ctx, `${this.base}/projects/${projectPath(fullName)}`, 'commits');
    assertListOk(res, 'repo'); // W17-39: never normalize an error body
    return normalizeRepo(res.body as RawGitlabProject);
  }

  async listCommits(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeCommit>> {
    let url = `${this.base}/projects/${projectPath(repo)}/repository/commits`;
    if (q.since) url += `?since=${encodeURIComponent(q.since)}`;
    return this.paged<RawGitlabCommit, ForgeCommit>(
      ctx,
      url,
      q.cursor,
      'commits',
      normalizeCommit,
      q.perPage ?? GITLAB_MAX_PER_PAGE,
      { entity: 'commits' },
    );
  }

  /**
   * TWO requests, deliberately: the commit endpoint carries `stats` but no file
   * list, and the diff endpoint carries files but no totals. Both are needed,
   * and the per-file churn is COUNTED from the unified diff GitLab returns —
   * exact numbers, not the zeros the Gitea adapter has to record.
   */
  async getCommitFiles(
    ctx: CallCtx,
    repo: string,
    sha: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDiffFile> & { stats: { additions: number; deletions: number } }> {
    const project = projectPath(repo);
    const detail = await this.get(
      ctx,
      `${this.base}/projects/${project}/repository/commits/${sha}`,
      'commits',
    );
    assertListOk(detail, 'commit_files');
    const body = detail.body as RawGitlabCommit;
    const files = await this.paged<RawGitlabDiff, ForgeDiffFile>(
      ctx,
      `${this.base}/projects/${project}/repository/commits/${sha}/diff`,
      cursor,
      'commits',
      normalizeDiff,
      undefined,
      { entity: 'commit_files' },
    );
    return {
      ...files,
      stats: {
        additions: body.stats?.additions ?? 0,
        deletions: body.stats?.deletions ?? 0,
      },
    };
  }

  async listPullRequests(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgePR>> {
    let url = `${this.base}/projects/${projectPath(repo)}/merge_requests?state=all&order_by=updated_at&sort=desc`;
    if (q.since) url += `&updated_after=${encodeURIComponent(q.since)}`;
    return this.paged<RawGitlabMr, ForgePR>(
      ctx,
      url,
      q.cursor,
      'pulls',
      normalizePR,
      q.perPage ?? GITLAB_MAX_PER_PAGE,
      { entity: 'prs' },
    );
  }

  async getPullRequest(ctx: CallCtx, repo: string, n: number): Promise<ForgePR> {
    // Addressed by iid — the project-scoped number — not by global id.
    const res = await this.get(
      ctx,
      `${this.base}/projects/${projectPath(repo)}/merge_requests/${n}`,
      'pulls',
    );
    return normalizePR(res.body as RawGitlabMr);
  }

  async getPullRequestFiles(
    ctx: CallCtx,
    repo: string,
    n: number,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDiffFile>> {
    return this.paged<RawGitlabDiff, ForgeDiffFile>(
      ctx,
      `${this.base}/projects/${projectPath(repo)}/merge_requests/${n}/diffs`,
      cursor,
      'pull_files',
      normalizeDiff,
      undefined,
      { entity: 'pr_files' },
    );
  }

  /**
   * Approvals, not reviews. GitLab has no review object equivalent to GitHub's;
   * the approvals API is the closest thing with a reviewer and a timestamp.
   * Comment-level review lives in discussions, which is a different model and
   * is deliberately not flattened into this shape.
   */
  async listReviews(ctx: CallCtx, repo: string, n: number): Promise<ForgeReview[]> {
    const res = await this.get(
      ctx,
      `${this.base}/projects/${projectPath(repo)}/merge_requests/${n}/approvals`,
      'pulls',
    );
    assertListOk(res, 'reviews');
    const body = res.body as { approved_by?: RawGitlabApproval[] } | null;
    return (body?.approved_by ?? [])
      .map((a) => normalizeApproval(a, n))
      .filter((r): r is ForgeReview => r !== null);
  }

  async listCheckRuns(
    ctx: CallCtx,
    repo: string,
    q: SinceQuery & { headSha?: string },
  ): Promise<Page<ForgeCheckRun>> {
    const sha = q.headSha ?? '';
    if (!sha) return { items: [] };
    return this.paged<RawGitlabPipeline, ForgeCheckRun>(
      ctx,
      `${this.base}/projects/${projectPath(repo)}/pipelines?sha=${encodeURIComponent(sha)}`,
      q.cursor,
      'checks',
      (p) => normalizePipeline(p, sha),
      undefined,
      { entity: 'checks' },
    );
  }

  async listReleases(
    ctx: CallCtx,
    repo: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeRelease>> {
    return this.paged<RawGitlabRelease, ForgeRelease>(
      ctx,
      `${this.base}/projects/${projectPath(repo)}/releases`,
      cursor,
      'releases',
      normalizeRelease,
      undefined,
      { entity: 'releases' },
    );
  }

  async listDeployments(
    ctx: CallCtx,
    repo: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDeployment>> {
    const page = await this.paged<
      {
        id: number;
        sha?: string;
        environment?: { name?: string } | null;
        created_at?: string;
        status?: string;
      },
      ForgeDeployment
    >(
      ctx,
      `${this.base}/projects/${projectPath(repo)}/deployments`,
      cursor,
      'commits',
      (d) => ({
        externalId: String(d.id),
        sha: d.sha ?? '',
        environment: d.environment?.name ?? 'unknown',
        createdAt: d.created_at ?? '',
        latestStatus:
          d.status === 'success'
            ? 'success'
            : d.status === 'failed'
              ? 'failure'
              : d.status === 'canceled'
                ? 'inactive'
                : d.status === 'running' || d.status === 'created'
                  ? 'pending'
                  : null,
      }),
      undefined,
      { entity: 'deployments' },
    );
    return page;
  }

  async listIssues(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeIssue>> {
    let url = `${this.base}/projects/${projectPath(repo)}/issues?state=all`;
    if (q.since) url += `&updated_after=${encodeURIComponent(q.since)}`;
    return this.paged<RawGitlabIssue, ForgeIssue>(
      ctx,
      url,
      q.cursor,
      'issues',
      normalizeIssue,
      q.perPage ?? GITLAB_MAX_PER_PAGE,
      { entity: 'issues' },
    );
  }

  async getFileContent(
    ctx: CallCtx,
    repo: string,
    path: string,
    ref: string,
  ): Promise<ForgeFileContent> {
    // The FILE PATH is url-encoded too, not just the project.
    const res = await this.get(
      ctx,
      `${this.base}/projects/${projectPath(repo)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
      'contents',
    );
    return normalizeFileContent(res.body as RawGitlabFile, path, ref);
  }

  /**
   * Not supported (W8-03). `supportsTarball` is false, so a caller that branches
   * on the capability — which the port requires — never reaches this. It throws
   * rather than returning an empty archive: an empty snapshot would scan clean
   * and report a repo as having no findings.
   */
  async getTarball(_ctx: CallCtx, _repo: string, _sha: string): Promise<ForgeTarball> {
    throw new Error('GitLab archive download is not implemented — check supportsTarball first');
  }

  async registerWebhook(
    ctx: CallCtx,
    repo: string,
    url: string,
    secret: string,
    events: string[],
  ): Promise<string> {
    // GitLab takes one boolean per event rather than an events array, so the
    // caller's event names are mapped onto the flags GitLab understands.
    const res = await this.client.request(ctx, {
      method: 'POST',
      url: `${this.base}/projects/${projectPath(repo)}/hooks`,
      family: 'commits',
      getHeaders: this.getHeaders,
      body: {
        url,
        token: secret,
        push_events: events.includes('push'),
        merge_requests_events: events.includes('pull_request') || events.includes('merge_request'),
        issues_events: events.includes('issues'),
        pipeline_events: events.includes('pipeline') || events.includes('check_run'),
        releases_events: events.includes('release'),
        enable_ssl_verification: true,
      },
    });
    const body = res.body as { id?: number };
    return String(body.id ?? '');
  }

  /**
   * GitLab sends the SECRET ITSELF in X-Gitlab-Token — no HMAC, no signature
   * over the body. The `rawBody` parameter is therefore unused here, which is
   * not an oversight: it is GitLab's scheme, and it means a GitLab delivery
   * carries weaker integrity guarantees than a GitHub or Gitea one.
   */
  verifyWebhook(_rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    return verifyWebhookToken(signatureHeader, secret);
  }
}
