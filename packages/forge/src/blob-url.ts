// The web address of a file in a forge (W16-41).
//
// A finding's whole value is "look at this one", and the next thing anyone does
// after reading one is open the code. The detail panel rendered
// `src/service.ts:15–18` as PLAIN TEXT, so on a triage tool the step after the
// finding was to go and find the file by hand.
//
// PURE — no network, no CallCtx, no budget. This is string construction, so it
// does not go through the budgeted client and does not violate Law 7; it lives
// beside the providers because the shape differs per forge and a `kind` switch
// in the API layer is exactly the knowledge this package exists to hold.
//
// Every path form below was VERIFIED against a live instance rather than
// recalled (Law 2):
//   github  /blob/{ref}/{path}          — github.com/github/codeql/blob/<sha>/README.md → 200
//   gitea   /src/commit/{sha}/{path}    — gitea.com/gitea/tea/src/commit/HEAD/README.md → 200
//           /src/branch/{branch}/{path} — gitea.com/gitea/tea/src/branch/main/README.md → 200
//   gitlab  /-/blob/{ref}/{path}        — gitlab.com/gitlab-org/gitlab-foss/-/blob/master/README.md → 200
//
// The #L anchor is a BROWSER fragment: it is never sent to the server, so a
// wrong one degrades to "the file opens without the line highlighted" and can
// never produce a 404. The path is the part that had to be right.

export type ForgeKind = 'github' | 'gitea' | 'gitlab';

/** Which kind of ref the link is pinned to — the reader deserves to know. */
export type RefKind = 'commit' | 'branch';

/**
 * The WEB root of a forge, from the API base a connection stores.
 *
 * These are not the same thing, which is the trap (W16-41):
 *   github  stores the API host — `https://api.github.com`, or on Enterprise
 *           `https://HOST/api/v3` (verified in GitHub's Enterprise Server REST
 *           quickstart). The web root is github.com / HOST.
 *   gitea   stores the INSTANCE root and appends /api/v1 itself.
 *   gitlab  stores the INSTANCE root and appends /api/v4 itself.
 *
 * A null base is not "unknown": for the hosted forges it means the public
 * instance, which is how the provider clients already read it. For Gitea there
 * is no public default to fall back to — it is self-hosted by definition — so
 * null there really is unknown, and the caller gets no link rather than a
 * guessed one.
 */
export function webBaseUrl(kind: ForgeKind, apiBaseUrl: string | null): string | null {
  const trimmed = (apiBaseUrl ?? '').replace(/\/+$/, '');
  if (kind === 'github') {
    if (!trimmed) return 'https://github.com';
    if (trimmed === 'https://api.github.com') return 'https://github.com';
    return trimmed.replace(/\/api\/v3$/, '');
  }
  if (kind === 'gitlab') {
    if (!trimmed) return 'https://gitlab.com';
    return trimmed.replace(/\/api\/v4$/, '');
  }
  // gitea
  if (!trimmed) return null;
  return trimmed.replace(/\/api\/v1$/, '');
}

export interface BlobUrlInput {
  kind: ForgeKind;
  /** Instance root, e.g. https://github.com or https://git.example.com. */
  baseUrl: string;
  org: string;
  repo: string;
  /** Repo-relative path, e.g. src/payments/charge.ts. */
  path: string;
  ref: string;
  refKind: RefKind;
  lineStart?: number | null;
  lineEnd?: number | null;
}

/** Percent-encode a path without destroying its separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function anchor(kind: ForgeKind, start?: number | null, end?: number | null): string {
  if (start === null || start === undefined) return '';
  // A one-line finding gets a one-line anchor. "#L15-L15" is not wrong, but it
  // reads as a range that isn't one — the same reason locationOf collapses
  // "15–15" to "15" on screen (W16-40).
  if (end === null || end === undefined || end === start) return `#L${start}`;
  // GitLab writes the second bound WITHOUT the L; GitHub and Gitea repeat it.
  return kind === 'gitlab' ? `#L${start}-${end}` : `#L${start}-L${end}`;
}

/**
 * A link to `path` in the forge, at `ref`.
 *
 * Returns null when there is nothing to link to — no base URL recorded for the
 * connection, or a finding that is about the REPOSITORY rather than a file. A
 * null is what lets the caller render no link at all, which is the honest
 * outcome; a link to the repository root pretending to be a link to the finding
 * is worse than none.
 */
export function blobUrl(input: BlobUrlInput): string | null {
  const base = input.baseUrl.replace(/\/+$/, '');
  if (!base || !input.path || !input.ref) return null;

  const repoPath = `${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}`;
  const file = encodePath(input.path);
  const frag = anchor(input.kind, input.lineStart, input.lineEnd);

  switch (input.kind) {
    case 'github':
      return `${base}/${repoPath}/blob/${encodeURIComponent(input.ref)}/${file}${frag}`;
    case 'gitlab':
      return `${base}/${repoPath}/-/blob/${encodeURIComponent(input.ref)}/${file}${frag}`;
    case 'gitea':
      // Gitea's path states which KIND of ref it is, so a commit link and a
      // branch link are different URLs rather than one URL that guesses.
      return `${base}/${repoPath}/src/${input.refKind}/${encodeURIComponent(input.ref)}/${file}${frag}`;
  }
}

/**
 * A link to pull request `number` in the forge (W20-12, UX_TODO DSH-38).
 *
 * Same purity as blobUrl: string construction only, no request. The three
 * forms are each forge's public PR page:
 *   github  /{org}/{repo}/pull/{n}
 *   gitlab  /{org}/{repo}/-/merge_requests/{n}
 *   gitea   /{org}/{repo}/pulls/{n}
 */
export function pullUrl(input: {
  kind: ForgeKind;
  baseUrl: string;
  org: string;
  repo: string;
  number: number;
}): string | null {
  const base = input.baseUrl.replace(/\/+$/, '');
  if (!base || !Number.isInteger(input.number) || input.number <= 0) return null;
  const repoPath = `${encodeURIComponent(input.org)}/${encodeURIComponent(input.repo)}`;
  switch (input.kind) {
    case 'github':
      return `${base}/${repoPath}/pull/${input.number}`;
    case 'gitlab':
      return `${base}/${repoPath}/-/merge_requests/${input.number}`;
    case 'gitea':
      return `${base}/${repoPath}/pulls/${input.number}`;
  }
}
