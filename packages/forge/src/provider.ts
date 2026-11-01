// ForgeProvider port (FR-FORGE-1). Verbatim from docs/design/FORGE_PROVIDER.md
// §2 - ingest imports only this interface; optional ops guarded by capability
// flags, callers must branch, never try/catch feature-detect.

import type {
  CallCtx,
  ForgeCapabilities,
  ForgeCheckRun,
  ForgeCodeScanningAlert,
  ForgeCodeScanningState,
  ForgeCommit,
  ForgeComparison,
  ForgeDiffFile,
  ForgeFileContent,
  ForgeTarball,
  ForgeIssue,
  ForgePR,
  ForgeRelease,
  ForgeDeployment,
  ForgeRepo,
  ForgeTokenInfo,
  ForgeReview,
  ForgeReviewComment,
  ForgeReviewRequest,
  ForgeCursor,
  Page,
  SinceQuery,
} from './types.js';

export interface ForgeProvider {
  readonly kind: 'github' | 'gitea' | 'gitlab';
  readonly capabilities: ForgeCapabilities;

  listRepos(ctx: CallCtx, cursor?: ForgeCursor): Promise<Page<ForgeRepo>>;
  getRepo(ctx: CallCtx, fullName: string): Promise<ForgeRepo>;
  listCommits(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeCommit>>; // FR-INGEST-2/6
  getCommitFiles(
    ctx: CallCtx,
    repo: string,
    sha: string,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDiffFile> & { stats: { additions: number; deletions: number } }>; // paginate <=3,000 files
  listPullRequests(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgePR>>; // sort=updated for cursors
  getPullRequest(ctx: CallCtx, repo: string, n: number): Promise<ForgePR>; // fills additions/deletions
  getPullRequestFiles(
    ctx: CallCtx,
    repo: string,
    n: number,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeDiffFile>>; // NEVER raw diff (406 risk)
  listReviews(ctx: CallCtx, repo: string, n: number): Promise<ForgeReview[]>;
  /**
   * Inline review comments with their diff anchors (W18-23). OPTIONAL because
   * only GitHub reports whether a comment is still anchored on the head diff;
   * an adapter without that signal leaves this out, and the AI-reviewer screen
   * says "line-level data not available for this forge" instead of guessing.
   */
  listReviewComments?(
    ctx: CallCtx,
    repo: string,
    n: number,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeReviewComment>>;
  /**
   * When each reviewer was asked (W20-24, UX_TODO DSH-41), from the forge's
   * issue events. OPTIONAL: an adapter without it leaves the review queue
   * measuring from when the pull request opened, and the screen says so.
   */
  listReviewRequests?(
    ctx: CallCtx,
    repo: string,
    n: number,
    cursor?: ForgeCursor,
  ): Promise<Page<ForgeReviewRequest>>;
  listCheckRuns(
    ctx: CallCtx,
    repo: string,
    q: SinceQuery & { headSha?: string },
  ): Promise<Page<ForgeCheckRun>>;
  listReleases(ctx: CallCtx, repo: string, cursor?: ForgeCursor): Promise<Page<ForgeRelease>>;
  listDeployments(ctx: CallCtx, repo: string, cursor?: ForgeCursor): Promise<Page<ForgeDeployment>>;
  listIssues(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeIssue>>;
  getFileContent(ctx: CallCtx, repo: string, path: string, ref: string): Promise<ForgeFileContent>; // FR-FORGE-6 only

  /**
   * The files that differ between `base` and `head` (W23-03), through the
   * budgeted client. OPTIONAL like the other ops a forge may lack: a caller
   * without it does the full work. Every adapter in this package implements it.
   * Throws ForgeHttpError when the forge refuses (an unknown base after a force
   * push answers 404); the incremental planner reads any throw as "full".
   */
  compareCommits?(
    ctx: CallCtx,
    repo: string,
    base: string,
    head: string,
  ): Promise<ForgeComparison>;
  /**
   * The tree object id of a commit (W23-03): equal trees mean byte-identical
   * source, whatever the commit ids say. null where the forge cannot say (GitLab
   * exposes no tree id on a commit), and the caller then works from the commit.
   */
  getCommitTreeSha?(ctx: CallCtx, repo: string, sha: string): Promise<string | null>;

  /**
   * Source archive for one commit — capability-guarded by `supportsTarball`
   * (W8-03, C1a exception). Callers branch on the capability; they never
   * try/catch feature-detect.
   *
   * ONLY the snapshot service may call this. It is the single sanctioned way
   * whole-repo source reaches this machine, and validate-arch rule 6 fails the
   * build if anything else calls it or if `git clone` appears anywhere.
   */
  getTarball(ctx: CallCtx, repo: string, sha: string): Promise<ForgeTarball>;

  /**
   * Code-scanning alerts (W18-24) — guarded by
   * `capabilities.supportsCodeScanningAlerts`, and optional so an adapter for
   * a forge without the feature does not have to carry a stub that throws.
   * A missing permission surfaces as ForgeHttpError 403 (the caller says so);
   * a repository with code scanning off answers 404.
   *
   * OPEN alerts by default. W20-25 (UX_TODO FND-63): `state` also reads the
   * dismissed and fixed ones, most recently updated first. Read-only (D9a).
   */
  listCodeScanningAlerts?(
    ctx: CallCtx,
    repo: string,
    cursor?: ForgeCursor,
    opts?: { state?: ForgeCodeScanningState },
  ): Promise<Page<ForgeCodeScanningAlert>>;
  /**
   * The token's owner login and expiry, where the forge reports them (W20-25,
   * UX_TODO ADM-50). Personal-token connections only: an App installation has
   * no owner account. Throws ForgeHttpError when the forge refuses.
   */
  getTokenInfo?(ctx: CallCtx): Promise<ForgeTokenInfo>;
  registerWebhook(
    ctx: CallCtx,
    repo: string,
    url: string,
    secret: string,
    events: string[],
  ): Promise<string>;
  /**
   * Remove every hook on `repo` that delivers to `url`, and say how many
   * (W20-15, UX_TODO X-27: uninstall). Matched by delivery URL rather than a
   * stored hook id, so hooks registered before ids were kept are found too,
   * and a hook someone else added for another service is never touched.
   * Optional: an adapter without it cannot clean up and says so.
   */
  deleteWebhooks?(ctx: CallCtx, repo: string, url: string): Promise<number>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string, secret: string): boolean; // timingSafeEqual, sync
}
