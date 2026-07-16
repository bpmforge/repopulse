// Normalized domain types (FR-FORGE-1). Verbatim from
// docs/design/FORGE_PROVIDER.md §1-2 — do not diverge without updating that doc.

export type ForgeCursor = string; // opaque; adapter-encoded (page/GraphQL cursor/updated_at)
export interface Page<T> {
  items: T[];
  nextCursor?: ForgeCursor;
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
  maxPerPage: number; // GitHub 100 / Gitea MAX_RESPONSE_ITEMS (50 default)
}

export interface SinceQuery {
  since?: string;
  cursor?: ForgeCursor;
  perPage?: number;
}

export type Lane = 'webhook' | 'user' | 'backfill' | 'reconcile'; // priority, high->low

export interface CallCtx {
  lane: Lane;
  repoId?: string;
  etagKey?: string;
} // every op takes one

// Endpoint families for BudgetedClient secondary buckets (§3).
export type EndpointFamily =
  'commits' | 'pulls' | 'pull_files' | 'checks' | 'contents' | 'issues' | 'releases' | 'graphql';
