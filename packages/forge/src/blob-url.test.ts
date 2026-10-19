import { describe, expect, it } from 'vitest';
import { blobUrl, pullUrl, webBaseUrl } from './blob-url.js';

// W16-41. A finding's detail panel rendered `src/service.ts:15–18` as plain
// text, so on a triage tool whose entire workflow is "look at this one", the
// step after reading a finding was to go and find the file by hand.
//
// Every path form here was verified against a live instance before it was
// written (Law 2) — see the header of blob-url.ts for the URLs and their
// status codes. These tests pin the shapes so a later edit cannot quietly
// reintroduce a guess.

const base = {
  baseUrl: 'https://example.com',
  org: 'acme',
  repo: 'payments',
  path: 'src/payments/charge.ts',
  ref: 'abc123',
  refKind: 'commit' as const,
};

describe('a link to a file in the forge (W16-41)', () => {
  it('builds the GitHub form', () => {
    expect(blobUrl({ ...base, kind: 'github', lineStart: 10, lineEnd: 12 })).toBe(
      'https://example.com/acme/payments/blob/abc123/src/payments/charge.ts#L10-L12',
    );
  });

  it('builds the GitLab form, whose second bound has no L', () => {
    expect(blobUrl({ ...base, kind: 'gitlab', lineStart: 10, lineEnd: 12 })).toBe(
      'https://example.com/acme/payments/-/blob/abc123/src/payments/charge.ts#L10-12',
    );
  });

  it("states the ref KIND in Gitea's path, because Gitea's path does", () => {
    expect(blobUrl({ ...base, kind: 'gitea', lineStart: 10, lineEnd: 12 })).toBe(
      'https://example.com/acme/payments/src/commit/abc123/src/payments/charge.ts#L10-L12',
    );
    expect(blobUrl({ ...base, kind: 'gitea', ref: 'main', refKind: 'branch', lineStart: 10 })).toBe(
      'https://example.com/acme/payments/src/branch/main/src/payments/charge.ts#L10',
    );
  });

  it('writes a one-line finding as one line', () => {
    // "#L15-L15" is not wrong, but it reads as a range that is not one — the
    // same reason locationOf collapses "15–15" to "15" on screen (W16-40).
    expect(blobUrl({ ...base, kind: 'github', lineStart: 15, lineEnd: 15 })).toMatch(/#L15$/);
    expect(blobUrl({ ...base, kind: 'github', lineStart: 15 })).toMatch(/#L15$/);
  });

  it('omits the anchor when there is no line', () => {
    expect(blobUrl({ ...base, kind: 'github' })).toBe(
      'https://example.com/acme/payments/blob/abc123/src/payments/charge.ts',
    );
  });

  it('has NO LINK rather than a wrong one', () => {
    // A finding about the whole repository has no file, and a self-hosted
    // connection may have no base URL recorded. A link to the repository root
    // pretending to be a link to the finding is worse than no link.
    expect(blobUrl({ ...base, kind: 'github', path: '' })).toBeNull();
    expect(blobUrl({ ...base, kind: 'github', baseUrl: '' })).toBeNull();
    expect(blobUrl({ ...base, kind: 'github', ref: '' })).toBeNull();
  });

  it('survives a trailing slash on the instance URL and spaces in a path', () => {
    expect(
      blobUrl({
        ...base,
        kind: 'github',
        baseUrl: 'https://example.com/',
        path: 'src/my folder/a b.ts',
      }),
    ).toBe('https://example.com/acme/payments/blob/abc123/src/my%20folder/a%20b.ts');
  });
});

// The API base a connection stores is NOT the web root, which is the trap this
// feature walks into (W16-41): GitHub stores api.github.com, and on Enterprise
// `https://HOST/api/v3` — verified in GitHub's Enterprise Server REST
// quickstart. Gitea and GitLab store the instance root and append their own
// /api/vN, so for them the two coincide.
describe('the web root behind an API base (W16-41)', () => {
  it('turns the GitHub API host into the site', () => {
    expect(webBaseUrl('github', null)).toBe('https://github.com');
    expect(webBaseUrl('github', 'https://api.github.com')).toBe('https://github.com');
    expect(webBaseUrl('github', 'https://ghe.example.com/api/v3')).toBe('https://ghe.example.com');
  });

  it('leaves an instance root alone for the forges that store one', () => {
    expect(webBaseUrl('gitlab', null)).toBe('https://gitlab.com');
    expect(webBaseUrl('gitlab', 'https://gitlab.example.com')).toBe('https://gitlab.example.com');
    expect(webBaseUrl('gitlab', 'https://gitlab.example.com/api/v4')).toBe(
      'https://gitlab.example.com',
    );
    expect(webBaseUrl('gitea', 'https://git.example.com/api/v1')).toBe('https://git.example.com');
  });

  it('has no default for Gitea, which is self-hosted by definition', () => {
    // null here really is unknown — unlike github/gitlab, where it means the
    // public instance. A guessed host would produce a link that 404s.
    expect(webBaseUrl('gitea', null)).toBeNull();
  });
});

describe('a link to a pull request in the forge (W20-12, DSH-38)', () => {
  const pr = { baseUrl: 'https://example.com/', org: 'acme', repo: 'payments', number: 412 };
  it("uses each forge's own PR page", () => {
    expect(pullUrl({ ...pr, kind: 'github' })).toBe('https://example.com/acme/payments/pull/412');
    expect(pullUrl({ ...pr, kind: 'gitlab' })).toBe(
      'https://example.com/acme/payments/-/merge_requests/412',
    );
    expect(pullUrl({ ...pr, kind: 'gitea' })).toBe('https://example.com/acme/payments/pulls/412');
  });
  it('has no link rather than a wrong one', () => {
    expect(pullUrl({ ...pr, kind: 'github', baseUrl: '' })).toBeNull();
    expect(pullUrl({ ...pr, kind: 'github', number: 0 })).toBeNull();
  });
});
