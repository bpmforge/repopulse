// Normalized domain types (FR-FORGE-1). Verbatim from
// docs/design/FORGE_PROVIDER.md §1-2 — do not diverge without updating that doc.

export type ForgeCursor = string; // opaque; adapter-encoded (page/GraphQL cursor/updated_at)
export interface Page<T> {
  items: T[];
  nextCursor?: ForgeCursor;
}

/**
 * Which features the repository has switched on (W17-39). true = on, false =
 * switched off by the owner, ABSENT = the forge did not say — never read an
 * absent flag as "off". A disabled feature answers its list endpoint with a
 * 404 (Gitea) or a 200 that is empty / pull requests only (GitHub), so this
 * metadata is the only thing that tells "not enabled" from "refused".
 */
export interface ForgeRepoFeatures {
  issues?: boolean;
  pullRequests?: boolean;
  releases?: boolean;
}

/**
 * Drop the flags a forge did not send; undefined when it sent none. The input
 * admits `undefined` values because that is exactly what an absent JSON field
 * reads as (exactOptionalPropertyTypes).
 */
export function repoFeatures(
  f: Partial<Record<keyof ForgeRepoFeatures, boolean | undefined>>,
): ForgeRepoFeatures | undefined {
  const out: ForgeRepoFeatures = {};
  if (typeof f.issues === 'boolean') out.issues = f.issues;
  if (typeof f.pullRequests === 'boolean') out.pullRequests = f.pullRequests;
  if (typeof f.releases === 'boolean') out.releases = f.releases;
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ForgeRepo {
  externalId: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  isArchived: boolean;
  pushedAt: string | null;
  htmlUrl: string;
  /** W17-39: absent when the forge reported no feature flags (list payloads may omit them). */
  features?: ForgeRepoFeatures;
}

export interface ForgeCommit {
  sha: string;
  authorLogin: string | null;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  message: string;
  parentShas: string[]; // >1 parent => merge commit (METRICS.md excludes)
  stats?: { additions: number; deletions: number }; // only from getCommitFiles / GraphQL
}

export interface ForgeDiffFile {
  path: string;
  previousPath?: string; // rename tracking
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string; // unified hunks; ABSENT for huge files (research §3)
  patchTruncated: boolean; // true when forge omitted/clipped patch
}

export interface ForgePR {
  number: number;
  externalId: string;
  title: string;
  body: string | null;
  authorLogin: string;
  isBot: boolean;
  isDraft: boolean;
  state: 'open' | 'closed' | 'merged';
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergedByLogin: string | null;
  baseRef: string;
  headSha: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number; // absent on GitHub REST list items (research §3)
}

export interface ForgeReview {
  externalId: string;
  prNumber: number;
  reviewerLogin: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  submittedAt: string;
}

/**
 * One inline review comment (W18-23), as the forge anchors it to the diff.
 *
 * The body is deliberately absent: the AI-reviewer metrics count and locate
 * comments, they never read them, and a warehoused copy of review prose is
 * data nobody asked us to keep.
 *
 * `line` vs `originalLine` is the whole point of this shape. `originalLine` is
 * where the comment was written (on `originalCommitSha`); `line` is where it
 * sits on the PR's CURRENT head diff, and the forge sets it to null once a
 * later push changed the lines it was anchored to (GitHub's "Outdated").
 */
export interface ForgeReviewComment {
  externalId: string;
  prNumber: number;
  /** The review this comment was submitted with; null for a stand-alone comment. */
  reviewExternalId: string | null;
  authorLogin: string;
  createdAt: string;
  path: string;
  /** 'file' comments attach to a whole file and carry no line. */
  subjectType: 'line' | 'file';
  /** A reply inside an existing thread, not a new piece of feedback. */
  isReply: boolean;
  originalStartLine: number | null;
  originalLine: number | null;
  /** null = no longer anchored on the current head diff (outdated). */
  line: number | null;
  originalCommitSha: string;
  commitSha: string;
}

export interface ForgeCheckRun {
  externalId: string;
  headSha: string;
  name: string;
  workflowName?: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'neutral' | null;
  startedAt: string | null;
  completedAt: string | null;
  isRerunOf?: string; // rerun linkage -> FR-METRICS-9 flakiness
}

export interface ForgeRelease {
  externalId: string;
  tagName: string;
  name: string | null;
  isDraft: boolean;
  isPrerelease: boolean;
  publishedAt: string | null;
}

export interface ForgeDeployment {
  externalId: string;
  sha: string;
  environment: string;
  createdAt: string;
  latestStatus: 'success' | 'failure' | 'error' | 'inactive' | 'pending' | null;
}

export interface ForgeIssue {
  externalId: string;
  number: number;
  title: string;
  authorLogin: string;
  state: 'open' | 'closed';
  createdAt: string;
  closedAt: string | null;
  isPullRequest: boolean;
}

export interface ForgeFileContent {
  path: string;
  ref: string;
  sizeBytes: number;
  content: string | null;
  truncated: boolean; // null+truncated when >1MB (research §3 contents)
}

export interface ForgeCapabilities {
  supportsGraphQLBackfill: boolean; // GitHub true / Gitea false
  supportsDeployments: boolean; // Gitea likely false -> DORA falls back to releases (FR-METRICS-12)
  supportsCheckRuns: boolean; // Gitea: commit statuses only, version-dependent Actions API
  supportsStatsEndpoints: boolean; // GitHub 202-warmup stats; Gitea none
  supportsRawDiff: boolean; // GitHub 406s >300 files/20k lines - adapters may say false outright
  reportsTotalCounts: boolean; // Gitea x-total-count true / GitHub false
  hasRateLimits: boolean; // Gitea self-hosted false -> budgeter becomes pass-through
  supportsTarball: boolean; // W8-03: source archive download for snapshot scanners (C1a)
  maxPerPage: number; // GitHub 100 / Gitea MAX_RESPONSE_ITEMS (50 default)
  /**
   * How this forge authenticates a webhook delivery, which decides the receiver
   * route its hook is registered at (W17-36). 'hub-signature': an
   * X-Hub-Signature-256 HMAC over the body — GitHub, and Gitea, which sends the
   * GitHub-compatible headers too (verified live, 1.24.7). 'gitlab-token': the
   * shared secret itself in X-Gitlab-Token.
   */
  webhookScheme: 'hub-signature' | 'gitlab-token';
}

export interface SinceQuery {
  since?: string;
  cursor?: ForgeCursor;
  perPage?: number;
}

// W8-03: 'scan' sits between backfill and reconcile. A security scan is worth
// less than a user waiting on a page and less than filling in history someone
// asked for, but more than reconciliation, which is by definition catching up
// on data we already have — a scan blocked behind reconcile would never run on
// a busy workspace.
export type Lane = 'webhook' | 'user' | 'backfill' | 'scan' | 'reconcile'; // priority, high->low

export interface CallCtx {
  lane: Lane;
  repoId?: string;
  etagKey?: string;
} // every op takes one

// Endpoint families for BudgetedClient secondary buckets (§3).
export type EndpointFamily =
  'commits' | 'pulls' | 'pull_files' | 'checks' | 'contents' | 'issues' | 'releases' | 'graphql';

/**
 * A source archive for one pinned commit (W8-03, C1a exception, SECURITY_SUITE §1.4).
 *
 * Bytes, never a working copy: the archive is fetched through the budgeted
 * client, extracted under guard into an ephemeral scratch dir, scanned and
 * deleted. Nothing is cloned and nothing persists.
 */
export interface ForgeTarball {
  /** The SHA the archive is pinned to — every scan result is reproducible for it. */
  commitSha: string;
  /** gzip-compressed tar bytes. */
  bytes: Uint8Array;
  /** Where the bytes actually came from, for the audit trail (codeload, not the API host). */
  sourceHost: string;
}

/**
 * Split a forge full name into the (org, name) pair stored on a repo row, at
 * the LAST slash. GitLab namespaces nest (`platform/tools/widget`), and a split
 * on every slash stored org `platform`, name `tools` — a project that does not
 * exist, so every API call and webhook lookup for it failed. `${org}/${name}`
 * always rebuilds the original.
 */
export function splitRepoFullName(
  fullName: string,
  fallbackName = '',
): { org: string; name: string } {
  const i = fullName.lastIndexOf('/');
  if (i === -1) return { org: '', name: fullName || fallbackName };
  return { org: fullName.slice(0, i), name: fullName.slice(i + 1) || fallbackName };
}
