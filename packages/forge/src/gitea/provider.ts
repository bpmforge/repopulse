import { resolveTarball } from '../client/tarball.js';
import { assertListOk } from '../client/errors.js';
import type { ForgeResponse } from '../client/budgeted-client.js';
// ForgeHttpClient is declared alongside the GitHub adapter; both adapters take
// the same injected transport so the BudgetedClient serves either (Law 7).
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
  GITEA_MAX_PER_PAGE,
  nextPageCursor,
  pageOfCursor,
  totalCountOf,
  withPage,
} from './pagination.js';
import { verifyWebhookSignature } from './webhook.js';
import {
  normalizeCommit,
  normalizeCommitFile,
  normalizeFileContent,
  normalizeIssue,
  normalizePR,
  normalizePrFile,
  normalizeRelease,
  normalizeReview,
  normalizeStatus,
  type RawGiteaCommit,
  type RawGiteaFileContent,
  type RawGiteaIssue,
  type RawGiteaPR,
  type RawGiteaPrFile,
  type RawGiteaRelease,
  type RawGiteaRepo,
  type RawGiteaReview,
  type RawGiteaStatus,
} from './normalize.js';
import { normalizeRepo } from './normalize.js';

// GiteaProvider (FR-FORGE-7, FORGE_PROVIDER §5). Every response shape here was
// verified against a live Gitea v1 instance on 2026-08-14 — see normalize.ts
// for the three places Gitea genuinely differs from GitHub.

export const GITEA_CAPABILITIES: ForgeCapabilities = {
  supportsGraphQLBackfill: false, // REST only
  supportsDeployments: false, // releases carry the DORA deploy signal (FR-METRICS-12)
  supportsCheckRuns: false, // commit statuses instead — see normalizeStatus
  supportsStatsEndpoints: false,
  supportsRawDiff: false,
  reportsTotalCounts: true, // x-total-count → true percent-complete (INGESTION §7)
  hasRateLimits: false, // budgeter passes through; politeness cap below
  supportsTarball: true, // /archive/{sha}.tar.gz answers with bytes, no redirect
  maxPerPage: GITEA_MAX_PER_PAGE,
  webhookScheme: 'hub-signature',
  // W18-24: not supported yet — Gitea has no native code scanning. Teams here upload SARIF instead.
  supportsCodeScanningAlerts: false,
};

export interface GiteaProviderOptions {
  client: ForgeHttpClient;
  auth: AuthHeaderProvider;
  /** Self-hosted, so there is no sensible default — the operator's instance. */
  baseUrl: string;
}

export class GiteaProvider implements ForgeProvider {
  readonly kind = 'gitea' as const;
  readonly capabilities = GITEA_CAPABILITIES;

  private readonly client: ForgeHttpClient;
  private readonly auth: AuthHeaderProvider;
  private readonly base: string;

  constructor(opts: GiteaProviderOptions) {
    this.client = opts.client;
    this.auth = opts.auth;
    // Accept either "https://git.example.com" or a URL already ending in
    // /api/v1, so an operator pasting either form from their browser works.
    const trimmed = opts.baseUrl.replace(/\/+$/, '');
    this.base = trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
  }

  private getHeaders = (): Promise<Record<string, string>> => this.auth.headers();

  private async get(ctx: CallCtx, url: string, family: EndpointFamily): Promise<ForgeResponse> {
    return this.client.request(ctx, { method: 'GET', url, family, getHeaders: this.getHeaders });
  }

  /** One paginated GET, turning page number + x-total-count into a cursor. */
  private async paged<Raw, T>(
    ctx: CallCtx,
    baseUrl: string,
    cursor: ForgeCursor | undefined,
    family: EndpointFamily,
    map: (r: Raw) => T,
    perPage = GITEA_MAX_PER_PAGE,
    // Every list passes this: an HTTP error must reject, not read as an empty
    // page (W17-35 backfill lists, W17-38 enrichment fetches).
    check?: { entity: string; emptyOn?: readonly number[] },
  ): Promise<Page<T>> {
    const page = pageOfCursor(cursor);
    const res = await this.get(ctx, withPage(baseUrl, page, perPage), family);
    if (check && assertListOk(res, check.entity, check.emptyOn) === 'empty') return { items: [] };
    const raw = Array.isArray(res.body) ? (res.body as Raw[]) : [];
    const items = raw.map(map);
    const next = nextPageCursor(page, raw.length, perPage, totalCountOf(res.headers));
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  async listRepos(ctx: CallCtx, cursor?: ForgeCursor): Promise<Page<ForgeRepo>> {
    return this.paged<RawGiteaRepo, ForgeRepo>(
      ctx,
      `${this.base}/user/repos`,
      cursor,
      'commits',
      normalizeRepo,
      undefined,
      { entity: 'repos' },
    );
  }

  async getRepo(ctx: CallCtx, fullName: string): Promise<ForgeRepo> {
    const res = await this.get(ctx, `${this.base}/repos/${fullName}`, 'commits');
    assertListOk(res, 'repo'); // W17-39: never normalize an error body
    return normalizeRepo(res.body as RawGiteaRepo);
  }

  async listCommits(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeCommit>> {
    let url = `${this.base}/repos/${repo}/commits`;
    if (q.since) url += `?since=${encodeURIComponent(q.since)}`;
    return this.paged<RawGiteaCommit, ForgeCommit>(
      ctx,
      url,
      q.cursor,
      'commits',
      normalizeCommit,
      q.perPage ?? GITEA_MAX_PER_PAGE,
      // 409 "Git Repository is empty." — no commits yet, not a failure.
      { entity: 'commits', emptyOn: [409] },
    );
  }

  /**
   * One call, not two: a Gitea commit response embeds `files`, so there is no
   * separate diff fetch. It is also NOT paginated, hence the single request and
   * no next cursor.
   *
   * `stats` is accurate; the per-file additions/deletions are zero because
   * Gitea does not report them at all (normalize.ts DIFFERENCE 2).
   */
  async getCommitFiles(
    ctx: CallCtx,
    repo: string,
    sha: string,
    _cursor?: ForgeCursor,
  ): Promise<Page<ForgeDiffFile> & { stats: { additions: number; deletions: number } }> {
    const res = await this.get(ctx, `${this.base}/repos/${repo}/git/commits/${sha}`, 'commits');
    assertListOk(res, 'commit_files');
    const body = res.body as RawGiteaCommit;
    return {
      items: (body.files ?? []).map(normalizeCommitFile),
      stats: {
        additions: body.stats?.additions ?? 0,
        deletions: body.stats?.deletions ?? 0,
      },
    };
  }

  async listPullRequests(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgePR>> {
    // sort=recentupdate mirrors the GitHub adapter's updated-desc walk, so the
    // planner's recent-first window fills the same way on both forges.
    return this.paged<RawGiteaPR, ForgePR>(
      ctx,
      `${this.base}/repos/${repo}/pulls?state=all&sort=recentupdate`,
      q.cursor,
      'pulls',
      normalizePR,
      q.perPage ?? GITEA_MAX_PER_PAGE,
      { entity: 'prs' },
    );
  }

  async getPullRequest(ctx: CallCtx, repo: string, n: number): Promise<ForgePR> {
    const res = await this.get(ctx, `${this.base}/repos/${repo}/pulls/${n}`, 'pulls');
    return normalizePR(res.body as RawGiteaPR);
  }

  async getPullRequestFiles(
    ctx: CallCtx,
    repo: string,
    n: number,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDiffFile>> {
    // Unlike commit files, PR files DO carry per-file churn (verified live).
    return this.paged<RawGiteaPrFile, ForgeDiffFile>(
      ctx,
      `${this.base}/repos/${repo}/pulls/${n}/files`,
      cursor,
      'pulls',
      normalizePrFile,
      undefined,
      { entity: 'pr_files' },
    );
  }

  async listReviews(ctx: CallCtx, repo: string, n: number): Promise<ForgeReview[]> {
    const res = await this.get(ctx, `${this.base}/repos/${repo}/pulls/${n}/reviews`, 'pulls');
    assertListOk(res, 'reviews');
    const raw = Array.isArray(res.body) ? (res.body as RawGiteaReview[]) : [];
    return raw.map((r) => normalizeReview(r, n)).filter((r): r is ForgeReview => r !== null);
  }

  /**
   * Commit STATUSES, not check runs — `capabilities.supportsCheckRuns` is false
   * and callers are expected to branch on it. Returning statuses here rather
   * than throwing means a caller that ignores the flag degrades to coarser CI
   * data instead of failing outright.
   */
  async listCheckRuns(
    ctx: CallCtx,
    repo: string,
    q: SinceQuery & { headSha?: string },
  ): Promise<Page<ForgeCheckRun>> {
    const sha = q.headSha ?? '';
    if (!sha) return { items: [] };
    return this.paged<RawGiteaStatus, ForgeCheckRun>(
      ctx,
      `${this.base}/repos/${repo}/commits/${sha}/statuses`,
      q.cursor,
      'checks',
      (s) => normalizeStatus(s, sha),
      undefined,
      { entity: 'checks' },
    );
  }

  async listReleases(
    ctx: CallCtx,
    repo: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeRelease>> {
    return this.paged<RawGiteaRelease, ForgeRelease>(
      ctx,
      `${this.base}/repos/${repo}/releases`,
      cursor,
      'commits',
      normalizeRelease,
      undefined,
      { entity: 'releases' },
    );
  }

  /**
   * Gitea has no deployments API (`supportsDeployments: false`). Returning an
   * empty page rather than throwing is deliberate: the DORA deploy signal falls
   * back to releases (FR-METRICS-12), and a throw here would fail a backfill
   * over a capability the caller was told about up front.
   */
  async listDeployments(
    _ctx: CallCtx,
    _repo: string,
    _cursor?: ForgeCursor,
  ): Promise<Page<ForgeDeployment>> {
    return { items: [] };
  }

  async listIssues(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeIssue>> {
    // type=issues, or Gitea returns pull requests in the issue list too.
    let url = `${this.base}/repos/${repo}/issues?state=all&type=issues`;
    if (q.since) url += `&since=${encodeURIComponent(q.since)}`;
    return this.paged<RawGiteaIssue, ForgeIssue>(
      ctx,
      url,
      q.cursor,
      'issues',
      normalizeIssue,
      q.perPage ?? GITEA_MAX_PER_PAGE,
      { entity: 'issues' },
    );
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
      'commits',
    );
    return normalizeFileContent(res.body as RawGiteaFileContent, ref);
  }

  /**
   * Source archive for one commit (W8-03, C1a). Gitea answers with the bytes
   * directly rather than a redirect, so there is nothing to follow — the
   * shared resolver handles both shapes and this provider simply passes the
   * response through.
   */
  async getTarball(ctx: CallCtx, repo: string, sha: string): Promise<ForgeTarball> {
    const res = await this.client.request(ctx, {
      method: 'GET',
      url: `${this.base}/repos/${repo}/archive/${sha}.tar.gz`,
      family: 'commits',
      cost: 1,
      getHeaders: this.getHeaders,
    });
    return resolveTarball({
      commitSha: sha,
      apiHost: new URL(this.base).hostname,
      status: res.status,
      headers: res.headers,
      body: res.body,
      download: async () => {
        // Unreachable unless a Gitea deployment starts redirecting archives —
        // and if it does, we want to know rather than silently fetch from
        // wherever it points.
        throw new Error('Gitea archive responded with a redirect; not followed');
      },
    });
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
        type: 'gitea',
        active: true,
        events,
        // Gitea nests the config as strings, and takes the secret INSIDE
        // config — not as a sibling field the way GitHub does.
        config: { url, content_type: 'json', secret },
      },
    });
    const body = res.body as { id?: number };
    return String(body.id ?? '');
  }

  async deleteWebhooks(ctx: CallCtx, repo: string, url: string): Promise<number> {
    // One page of 50: a repository with more hooks than that is not one
    // RepoPulse registered on (it adds one per repository).
    const res = await this.client.request(ctx, {
      method: 'GET',
      url: `${this.base}/repos/${repo}/hooks?limit=50`,
      family: 'commits',
      getHeaders: this.getHeaders,
    });
    const hooks = (res.body as { id: number; config?: { url?: string } }[] | null) ?? [];
    let removed = 0;
    for (const hook of hooks) {
      if (hook.config?.url !== url) continue;
      await this.client.request(ctx, {
        method: 'DELETE',
        url: `${this.base}/repos/${repo}/hooks/${hook.id}`,
        family: 'commits',
        getHeaders: this.getHeaders,
      });
      removed += 1;
    }
    return removed;
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    return verifyWebhookSignature(rawBody, signatureHeader, secret);
  }
}
