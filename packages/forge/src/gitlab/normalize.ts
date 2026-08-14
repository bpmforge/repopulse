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

// GitLab v4 → domain normalizers (W12-01).
//
// Every shape verified against a LIVE instance (gitlab.com/api/v4, project
// gitlab-org/cli, 2026-08-14). GitLab diverges from GitHub more than Gitea
// does, and the differences are noted at the fields they affect.

export interface RawGitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  default_branch?: string | null;
  visibility?: string | null;
  archived?: boolean | null;
  last_activity_at?: string | null;
  web_url: string;
}

export function normalizeRepo(p: RawGitlabProject): ForgeRepo {
  return {
    externalId: String(p.id),
    name: p.name,
    fullName: p.path_with_namespace,
    defaultBranch: p.default_branch ?? 'main',
    // `visibility` is a STRING (public|internal|private), not a boolean.
    // `internal` means "any signed-in user of this instance" — not public, so
    // it groups with private for our purposes.
    isPrivate: (p.visibility ?? 'private') !== 'public',
    isArchived: p.archived ?? false,
    // No pushed_at; last_activity_at is the equivalent the planner orders by.
    pushedAt: p.last_activity_at ?? null,
    htmlUrl: p.web_url,
  };
}

export interface RawGitlabCommit {
  id: string;
  message?: string;
  title?: string;
  author_name?: string;
  author_email?: string;
  authored_date?: string;
  committed_date?: string;
  parent_ids?: string[] | null;
  stats?: { additions?: number; deletions?: number } | null;
}

export function normalizeCommit(c: RawGitlabCommit): ForgeCommit {
  return {
    sha: c.id, // GitLab calls it `id`, not `sha`
    // GitLab commit payloads carry NO user object — only a name and email
    // string. There is no login to record, so identity resolution falls back to
    // the email, which is exactly what IdentityResolver already does.
    authorLogin: null,
    authorEmail: c.author_email ?? '',
    authoredAt: c.authored_date ?? c.committed_date ?? '',
    committedAt: c.committed_date ?? c.authored_date ?? '',
    message: c.message ?? c.title ?? '',
    parentShas: c.parent_ids ?? [],
    // Present on the single-commit endpoint, absent from the list (verified).
    ...(c.stats
      ? { stats: { additions: c.stats.additions ?? 0, deletions: c.stats.deletions ?? 0 } }
      : {}),
  };
}

export interface RawGitlabDiff {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff?: string;
}

/**
 * Count added/removed lines from a unified diff.
 *
 * GitLab returns no per-file additions/deletions, but it DOES return the raw
 * unified diff — so churn is COUNTED here, not guessed. That is the difference
 * between this and the Gitea adapter, which has neither the counts nor the
 * patch and must record zero: here the numbers are exact.
 *
 * `+++`/`---` are the file headers, not content, and are excluded.
 */
export function churnOfDiff(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export function normalizeDiff(d: RawGitlabDiff): ForgeDiffFile {
  const { additions, deletions } = churnOfDiff(d.diff);
  const status: ForgeDiffFile['status'] = d.new_file
    ? 'added'
    : d.deleted_file
      ? 'removed'
      : d.renamed_file
        ? 'renamed'
        : 'modified';
  return {
    path: d.new_path ?? d.old_path ?? '',
    ...(d.renamed_file && d.old_path ? { previousPath: d.old_path } : {}),
    status,
    additions,
    deletions,
    // GitLab flags oversized diffs rather than omitting them silently.
    patchTruncated: d.diff === undefined,
    ...(d.diff !== undefined ? { patch: d.diff } : {}),
  };
}

export interface RawGitlabMr {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  author?: { username?: string } | null;
  merged_by?: { username?: string } | null;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  target_branch?: string | null;
  sha?: string | null;
  changes_count?: string | number | null;
}

export function normalizePR(m: RawGitlabMr): ForgePR {
  const login = m.author?.username ?? '';
  return {
    // iid is the PROJECT-scoped number users see in the UI and in URLs; `id` is
    // globally unique across the instance. Using `id` here would make every PR
    // link wrong, so iid is the number and id is the external identity.
    number: m.iid,
    externalId: String(m.id),
    title: m.title,
    body: m.description ?? null,
    authorLogin: login,
    isBot: login.endsWith('-bot') || login.endsWith('[bot]'),
    isDraft: m.draft ?? m.work_in_progress ?? false,
    // Unlike GitHub and Gitea, `merged` is a FIRST-CLASS state here rather than
    // closed + a flag. 'locked' collapses to closed.
    state: m.state === 'merged' ? 'merged' : m.state === 'opened' ? 'open' : 'closed',
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    mergedAt: m.merged_at ?? null,
    closedAt: m.closed_at ?? null,
    mergedByLogin: m.merged_by?.username ?? null,
    baseRef: m.target_branch ?? '',
    headSha: m.sha ?? '',
    // GitLab reports `changes_count` as a STRING, and as "32+" once it exceeds
    // its display cap — parseInt keeps the number and drops the marker rather
    // than letting NaN reach the warehouse.
    ...(m.changes_count !== null && m.changes_count !== undefined
      ? { changedFiles: Number.parseInt(String(m.changes_count), 10) || 0 }
      : {}),
  };
}

export interface RawGitlabApproval {
  user?: { username?: string } | null;
  created_at?: string | null;
}

/**
 * GitLab has no "review" object the way GitHub and Gitea do. The closest
 * equivalent to an approval is the approvals API; comment-level review is
 * discussions, which is a different shape entirely. We map approvals only, and
 * `supportsReviews` stays honest about the rest via capabilities.
 */
export function normalizeApproval(a: RawGitlabApproval, prNumber: number): ForgeReview | null {
  const login = a.user?.username;
  if (!login || !a.created_at) return null;
  return {
    externalId: `${prNumber}-${login}`,
    prNumber,
    reviewerLogin: login,
    state: 'APPROVED',
    submittedAt: a.created_at,
  };
}

export interface RawGitlabPipeline {
  id: number;
  sha?: string;
  status?: string;
  name?: string | null;
  ref?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export function normalizePipeline(p: RawGitlabPipeline, headSha: string): ForgeCheckRun {
  const s = p.status ?? '';
  const done = ['success', 'failed', 'canceled', 'skipped'].includes(s);
  return {
    externalId: String(p.id),
    headSha: p.sha ?? headSha,
    name: p.name ?? p.ref ?? `pipeline ${p.id}`,
    status: done ? 'completed' : s === 'created' || s === 'pending' ? 'queued' : 'in_progress',
    conclusion:
      s === 'success'
        ? 'success'
        : s === 'failed'
          ? 'failure'
          : s === 'canceled'
            ? 'cancelled'
            : s === 'skipped'
              ? 'skipped'
              : null,
    // A pipeline DOES have a real duration, unlike a Gitea commit status.
    startedAt: p.created_at ?? null,
    completedAt: done ? (p.updated_at ?? null) : null,
  };
}

export interface RawGitlabRelease {
  tag_name: string;
  name?: string | null;
  released_at?: string | null;
  created_at?: string | null;
  upcoming_release?: boolean | null;
}

export function normalizeRelease(r: RawGitlabRelease): ForgeRelease {
  return {
    // GitLab releases have NO id — the tag is the identity.
    externalId: r.tag_name,
    tagName: r.tag_name,
    name: r.name ?? null,
    // No draft concept; `upcoming_release` is the nearest thing to prerelease.
    isDraft: false,
    isPrerelease: r.upcoming_release ?? false,
    publishedAt: r.released_at ?? r.created_at ?? null,
  };
}

export interface RawGitlabIssue {
  id: number;
  iid: number;
  title: string;
  state: string;
  author?: { username?: string } | null;
  created_at: string;
  closed_at?: string | null;
}

export function normalizeIssue(i: RawGitlabIssue): ForgeIssue {
  return {
    externalId: String(i.id),
    number: i.iid,
    title: i.title,
    authorLogin: i.author?.username ?? '',
    state: i.state === 'closed' ? 'closed' : 'open',
    createdAt: i.created_at,
    closedAt: i.closed_at ?? null,
    // GitLab keeps issues and merge requests on separate endpoints entirely, so
    // an issue is never a PR here — unlike GitHub and Gitea, where the issue
    // list mixes them.
    isPullRequest: false,
  };
}

export interface RawGitlabFile {
  file_path?: string;
  size?: number;
  content?: string | null;
  encoding?: string | null;
}

export function normalizeFileContent(
  f: RawGitlabFile,
  path: string,
  ref: string,
): ForgeFileContent {
  const content = f.encoding === 'base64' && f.content ? f.content : null;
  return {
    path: f.file_path ?? path,
    ref,
    sizeBytes: f.size ?? 0,
    content,
    truncated: content === null,
  };
}
