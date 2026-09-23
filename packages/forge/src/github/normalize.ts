import type {
  ForgeCheckRun,
  ForgeCommit,
  ForgeDeployment,
  ForgeDiffFile,
  ForgeFileContent,
  ForgeIssue,
  ForgePR,
  ForgeRelease,
  ForgeRepo,
  ForgeReview,
} from '../types.js';
import { repoFeatures } from '../types.js';

// Pure GitHub-REST-JSON → normalized-domain-type mappers (FR-FORGE-1). Kept
// separate from the provider so every field mapping is unit-testable without a
// client. Raw shapes are the minimal subset of the documented REST payloads we
// read; unknown extra fields are ignored on purpose.

interface RawUser {
  login: string;
  type?: string;
}

export interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
  html_url: string;
  /** False when the owner switched Issues off; /issues then still answers 200 (W17-39). */
  has_issues?: boolean;
}

export function normalizeRepo(r: RawRepo): ForgeRepo {
  const features = repoFeatures({ issues: r.has_issues });
  return {
    externalId: String(r.id),
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    isPrivate: r.private,
    isArchived: r.archived,
    pushedAt: r.pushed_at,
    htmlUrl: r.html_url,
    ...(features ? { features } : {}),
  };
}

export interface RawCommit {
  sha: string;
  commit: {
    author: { name?: string; email?: string; date: string } | null;
    committer: { date: string } | null;
    message: string;
  };
  author: RawUser | null;
  parents: { sha: string }[];
  stats?: { additions: number; deletions: number };
}

export function normalizeCommit(c: RawCommit): ForgeCommit {
  return {
    sha: c.sha,
    authorLogin: c.author?.login ?? null,
    // Email is the churn/ownership attribution key when there's no login
    // (DATABASE.md §2 identities) — never dropped.
    authorEmail: c.commit.author?.email ?? '',
    authoredAt: c.commit.author?.date ?? c.commit.committer?.date ?? '',
    committedAt: c.commit.committer?.date ?? c.commit.author?.date ?? '',
    message: c.commit.message,
    parentShas: c.parents.map((p) => p.sha),
    ...(c.stats ? { stats: c.stats } : {}),
  };
}

export interface RawDiffFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

function diffStatus(status: string): ForgeDiffFile['status'] {
  if (status === 'added' || status === 'removed' || status === 'renamed') return status;
  return 'modified'; // modified | changed | copied | unchanged → modified
}

export function normalizeDiffFile(f: RawDiffFile): ForgeDiffFile {
  return {
    path: f.filename,
    ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
    status: diffStatus(f.status),
    additions: f.additions,
    deletions: f.deletions,
    ...(f.patch !== undefined ? { patch: f.patch } : {}),
    // GitHub omits `patch` for very large/binary files — the truncation signal.
    patchTruncated: f.patch === undefined,
  };
}

function isBot(user: RawUser | null): boolean {
  return user?.type === 'Bot' || (user?.login?.endsWith('[bot]') ?? false);
}

export interface RawPR {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  user: RawUser | null;
  draft?: boolean;
  state: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  merged_by?: RawUser | null;
  base: { ref: string };
  head: { sha: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export function normalizePR(p: RawPR): ForgePR {
  const state: ForgePR['state'] = p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed';
  return {
    number: p.number,
    externalId: p.node_id,
    title: p.title,
    body: p.body,
    authorLogin: p.user?.login ?? '',
    isBot: isBot(p.user),
    isDraft: p.draft ?? false,
    state,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at,
    closedAt: p.closed_at,
    mergedByLogin: p.merged_by?.login ?? null,
    baseRef: p.base.ref,
    headSha: p.head.sha,
    ...(p.additions !== undefined ? { additions: p.additions } : {}),
    ...(p.deletions !== undefined ? { deletions: p.deletions } : {}),
    ...(p.changed_files !== undefined ? { changedFiles: p.changed_files } : {}),
  };
}

export interface RawReview {
  id: number;
  user: RawUser | null;
  state: string;
  submitted_at?: string;
}

/** null when the review is a PENDING draft (never submitted → not a domain review). */
export function normalizeReview(r: RawReview, prNumber: number): ForgeReview | null {
  const state = r.state as ForgeReview['state'];
  if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(state)) return null;
  return {
    externalId: String(r.id),
    prNumber,
    reviewerLogin: r.user?.login ?? '',
    state,
    submittedAt: r.submitted_at ?? '',
  };
}

export interface RawCheckRun {
  id: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  check_suite?: { id: number } | null;
}

export function normalizeCheckRun(c: RawCheckRun): ForgeCheckRun {
  return {
    externalId: String(c.id),
    headSha: c.head_sha,
    name: c.name,
    status: c.status as ForgeCheckRun['status'],
    conclusion: c.conclusion as ForgeCheckRun['conclusion'],
    startedAt: c.started_at,
    completedAt: c.completed_at,
  };
}

export interface RawRelease {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
}

export function normalizeRelease(r: RawRelease): ForgeRelease {
  return {
    externalId: String(r.id),
    tagName: r.tag_name,
    name: r.name,
    isDraft: r.draft,
    isPrerelease: r.prerelease,
    publishedAt: r.published_at,
  };
}

export interface RawDeployment {
  id: number;
  sha: string;
  environment: string;
  created_at: string;
}

export function normalizeDeployment(
  d: RawDeployment,
  latestStatus: ForgeDeployment['latestStatus'] = null,
): ForgeDeployment {
  return {
    externalId: String(d.id),
    sha: d.sha,
    environment: d.environment,
    createdAt: d.created_at,
    latestStatus,
  };
}

export interface RawIssue {
  id: number;
  number: number;
  title: string;
  user: RawUser | null;
  state: string;
  created_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

export function normalizeIssue(i: RawIssue): ForgeIssue {
  return {
    externalId: String(i.id),
    number: i.number,
    title: i.title,
    authorLogin: i.user?.login ?? '',
    state: i.state === 'closed' ? 'closed' : 'open',
    createdAt: i.created_at,
    closedAt: i.closed_at,
    isPullRequest: i.pull_request !== undefined,
  };
}

export interface RawFileContent {
  path: string;
  size: number;
  content: string | null;
  encoding?: string;
}

export function normalizeFileContent(f: RawFileContent, ref: string): ForgeFileContent {
  // >1MB: GitHub returns content null (research §3 contents) → truncated.
  const truncated = f.content === null || f.encoding === 'none';
  return {
    path: f.path,
    ref,
    sizeBytes: f.size,
    content: truncated ? null : (f.content ?? null),
    truncated,
  };
}
