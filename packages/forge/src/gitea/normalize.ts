import type {
  ForgeCheckRun,
  ForgeCommit,
  ForgeDiffFile,
  ForgeFileContent,
  ForgeIssue,
  ForgePR,
  ForgeRelease,
  ForgeRepo,
  ForgeReview,
} from '../types.js';

// Gitea v1 → domain normalizers (FR-FORGE-7).
//
// Every shape below was verified against a LIVE Gitea instance
// (gitea.com/api/v1, 2026-08-14), not written from the swagger or from memory.
// Three differences from GitHub mattered enough to change the design; each is
// noted at the field it affects.

export interface RawGiteaRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
  updated_at?: string | null;
  html_url: string;
}

export function normalizeRepo(r: RawGiteaRepo): ForgeRepo {
  return {
    externalId: String(r.id),
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    isPrivate: r.private,
    isArchived: r.archived,
    // DIFFERENCE 1: Gitea has no `pushed_at`. `updated_at` is the closest
    // signal and is what the backfill planner orders repos by (recently-active
    // first). It moves on metadata edits too, so the ordering is slightly
    // noisier than GitHub's — ordering only, never correctness.
    pushedAt: r.updated_at ?? null,
    htmlUrl: r.html_url,
  };
}

export interface RawGiteaCommit {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
    committer: { name?: string; email?: string; date?: string } | null;
  };
  author: { login?: string } | null;
  parents?: { sha: string }[] | null;
  stats?: { additions?: number; deletions?: number } | null;
  files?: RawGiteaCommitFile[] | null;
}

export function normalizeCommit(c: RawGiteaCommit): ForgeCommit {
  const authored = c.commit.author?.date ?? c.commit.committer?.date ?? '';
  return {
    sha: c.sha,
    authorLogin: c.author?.login ?? null,
    authorEmail: c.commit.author?.email ?? '',
    authoredAt: authored,
    committedAt: c.commit.committer?.date ?? authored,
    message: c.commit.message,
    parentShas: (c.parents ?? []).map((p) => p.sha),
    ...(c.stats
      ? { stats: { additions: c.stats.additions ?? 0, deletions: c.stats.deletions ?? 0 } }
      : {}),
  };
}

export interface RawGiteaCommitFile {
  filename: string;
  status?: string;
}

/**
 * DIFFERENCE 2, and the one with real product consequences: a Gitea commit's
 * `files[]` carries ONLY `filename` and `status` — no per-file additions or
 * deletions — on both the list AND the single-commit endpoint. Verified on a
 * live instance; this is not a missing query parameter.
 *
 * So per-file churn is unavailable for commits. We return 0/0 per file and rely
 * on the commit-level `stats`, which IS accurate. The consequence is that
 * hotspot ranking by per-file churn cannot be computed from Gitea commits the
 * way it can from GitHub — file-level attribution is absent at the source.
 * Recorded rather than papered over with a guess (splitting the commit total
 * evenly across files would look plausible and be fiction).
 *
 * PR files are different and DO carry churn — see normalizePrFile.
 */
export function normalizeCommitFile(f: RawGiteaCommitFile): ForgeDiffFile {
  return {
    path: f.filename,
    status: mapFileStatus(f.status),
    additions: 0,
    deletions: 0,
    patchTruncated: true, // no patch text is ever returned here
  };
}

export interface RawGiteaPrFile {
  filename: string;
  previous_filename?: string | null;
  status?: string;
  additions?: number;
  deletions?: number;
}

export function normalizePrFile(f: RawGiteaPrFile): ForgeDiffFile {
  return {
    path: f.filename,
    ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
    status: mapFileStatus(f.status),
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    patchTruncated: true,
  };
}

// Gitea reports 'changed' where GitHub says 'modified'; both use added/renamed,
// and Gitea uses 'deleted' for GitHub's 'removed'.
function mapFileStatus(s: string | undefined): ForgeDiffFile['status'] {
  switch (s) {
    case 'added':
      return 'added';
    case 'renamed':
      return 'renamed';
    case 'removed':
    case 'deleted':
      return 'removed';
    default:
      return 'modified';
  }
}

export interface RawGiteaPR {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  merged?: boolean;
  draft?: boolean;
  user?: { login?: string } | null;
  merged_by?: { login?: string } | null;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  base?: { ref?: string } | null;
  head?: { sha?: string } | null;
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
}

export function normalizePR(p: RawGiteaPR): ForgePR {
  // Gitea's `state` is only open|closed; a merged PR reads closed with
  // merged:true. Collapsing that into our three-state model here keeps every
  // metric that filters on 'merged' working identically across forges.
  const state: ForgePR['state'] = p.merged ? 'merged' : p.state === 'open' ? 'open' : 'closed';
  const login = p.user?.login ?? '';
  return {
    number: p.number,
    externalId: String(p.id),
    title: p.title,
    body: p.body ?? null,
    authorLogin: login,
    isBot: login.endsWith('[bot]') || login.endsWith('-bot'),
    isDraft: p.draft ?? false,
    state,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at ?? null,
    closedAt: p.closed_at ?? null,
    mergedByLogin: p.merged_by?.login ?? null,
    baseRef: p.base?.ref ?? '',
    headSha: p.head?.sha ?? '',
    // DIFFERENCE 3: like GitHub, the LIST omits these and the single-PR
    // endpoint fills them — verified live (list: null, detail: 233/6/4).
    ...(p.additions !== null && p.additions !== undefined ? { additions: p.additions } : {}),
    ...(p.deletions !== null && p.deletions !== undefined ? { deletions: p.deletions } : {}),
    ...(p.changed_files !== null && p.changed_files !== undefined
      ? { changedFiles: p.changed_files }
      : {}),
  };
}

export interface RawGiteaReview {
  id: number;
  state?: string;
  user?: { login?: string } | null;
  submitted_at?: string | null;
}

/** Returns null for review states we do not model (e.g. PENDING, REQUEST_REVIEW). */
export function normalizeReview(r: RawGiteaReview, prNumber: number): ForgeReview | null {
  const state = mapReviewState(r.state);
  if (!state || !r.submitted_at) return null;
  return {
    externalId: String(r.id),
    prNumber,
    reviewerLogin: r.user?.login ?? '',
    state,
    submittedAt: r.submitted_at,
  };
}

// Gitea says REQUEST_CHANGES where GitHub says CHANGES_REQUESTED, and COMMENT
// where GitHub says COMMENTED (both verified live).
function mapReviewState(s: string | undefined): ForgeReview['state'] | null {
  switch (s) {
    case 'APPROVED':
      return 'APPROVED';
    case 'REQUEST_CHANGES':
    case 'CHANGES_REQUESTED':
      return 'CHANGES_REQUESTED';
    case 'COMMENT':
    case 'COMMENTED':
      return 'COMMENTED';
    case 'DISMISSED':
      return 'DISMISSED';
    default:
      return null;
  }
}

export interface RawGiteaStatus {
  id: number;
  status?: string;
  context?: string;
  created_at?: string | null;
  updated_at?: string | null;
}

/**
 * Gitea has no check-runs API; commit STATUSES are the nearest equivalent
 * (capabilities.supportsCheckRuns is false, so callers branch rather than
 * feature-detect). A status is a point-in-time result with no start time, so
 * duration-based CI metrics cannot be derived from it — startedAt is null
 * rather than invented from created_at.
 */
export function normalizeStatus(s: RawGiteaStatus, headSha: string): ForgeCheckRun {
  const done = s.status === 'success' || s.status === 'failure' || s.status === 'error';
  return {
    externalId: String(s.id),
    headSha,
    name: s.context ?? '',
    status: done ? 'completed' : 'in_progress',
    conclusion:
      s.status === 'success'
        ? 'success'
        : s.status === 'failure' || s.status === 'error'
          ? 'failure'
          : null,
    startedAt: null,
    completedAt: done ? (s.updated_at ?? s.created_at ?? null) : null,
  };
}

export interface RawGiteaRelease {
  id: number;
  tag_name: string;
  name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
}

export function normalizeRelease(r: RawGiteaRelease): ForgeRelease {
  return {
    externalId: String(r.id),
    tagName: r.tag_name,
    name: r.name ?? null,
    isDraft: r.draft ?? false,
    isPrerelease: r.prerelease ?? false,
    publishedAt: r.published_at ?? null,
  };
}

export interface RawGiteaIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  user?: { login?: string } | null;
  created_at: string;
  closed_at?: string | null;
  pull_request?: unknown | null;
}

export function normalizeIssue(i: RawGiteaIssue): ForgeIssue {
  return {
    externalId: String(i.id),
    number: i.number,
    title: i.title,
    authorLogin: i.user?.login ?? '',
    state: i.state === 'closed' ? 'closed' : 'open',
    createdAt: i.created_at,
    closedAt: i.closed_at ?? null,
    // Gitea's issue list returns PRs too unless type=issues; the field is
    // non-null for a PR, exactly as on GitHub.
    isPullRequest: i.pull_request !== null && i.pull_request !== undefined,
  };
}

export interface RawGiteaFileContent {
  path: string;
  size?: number;
  content?: string | null;
  encoding?: string | null;
}

export function normalizeFileContent(f: RawGiteaFileContent, ref: string): ForgeFileContent {
  const content = f.encoding === 'base64' && f.content ? f.content : null;
  return {
    path: f.path,
    ref,
    sizeBytes: f.size ?? 0,
    content,
    truncated: content === null,
  };
}
