// ForgeProvider port (FR-FORGE-1). Verbatim from docs/design/FORGE_PROVIDER.md
// §2 - ingest imports only this interface; optional ops guarded by capability
// flags, callers must branch, never try/catch feature-detect.

import type {
  CallCtx,
  ForgeCapabilities,
  ForgeCheckRun,
  ForgeCommit,
  ForgeDiffFile,
  ForgeFileContent,
  ForgeIssue,
  ForgePR,
  ForgeRelease,
  ForgeDeployment,
  ForgeRepo,
  ForgeReview,
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
  listCheckRuns(
    ctx: CallCtx,
    repo: string,
    q: SinceQuery & { headSha?: string },
  ): Promise<Page<ForgeCheckRun>>;
  listReleases(ctx: CallCtx, repo: string, cursor?: ForgeCursor): Promise<Page<ForgeRelease>>;
  listDeployments(ctx: CallCtx, repo: string, cursor?: ForgeCursor): Promise<Page<ForgeDeployment>>;
  listIssues(ctx: CallCtx, repo: string, q: SinceQuery): Promise<Page<ForgeIssue>>;
  getFileContent(ctx: CallCtx, repo: string, path: string, ref: string): Promise<ForgeFileContent>; // FR-FORGE-6 only
  registerWebhook(
    ctx: CallCtx,
    repo: string,
    url: string,
    secret: string,
    events: string[],
  ): Promise<string>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string, secret: string): boolean; // timingSafeEqual, sync
}
