import { describe, expect, it } from 'vitest';
import { loadGithubFixtures } from '../fixtures/replay.js';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { GiteaProvider } from '../src/gitea/provider.js';
import { GitLabProvider } from '../src/gitlab/provider.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// compareCommits + getCommitTreeSha contract (W23-03, zero network).
//
// GitHub's small cases replay the fixtures under fixtures/github (authored from
// the documented shape: a live compare was not recorded offline, and the files
// say so in their provenance). The 300-file cap is generated, since a recorded
// 300-file response would be a 300-entry file nobody reads.

const ctx: CallCtx = { lane: 'scan' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'ghp_contract_test' });
const GH = 'https://api.github.com';
const GH_REPO = 'bpmforge/repopulse-fixture';

function fixtureRoute(scenario: string): StubRoute {
  const fx = loadGithubFixtures().find((f) => f.scenario === scenario);
  if (!fx) throw new Error(`missing fixture ${scenario}`);
  return {
    method: fx.request.method,
    url: fx.request.url,
    response: { status: fx.response.status, headers: fx.response.headers, body: fx.response.body },
  };
}

const github = (routes: StubRoute[]) => {
  const client = makeStubClient(routes);
  return { client, p: new GitHubProvider({ client, auth }) };
};

const rawFile = (n: number) => ({
  filename: `src/f${n}.ts`,
  status: 'modified',
  additions: 1,
  deletions: 0,
  changes: 1,
});

describe('GitHub compareCommits', () => {
  it('maps a recorded ahead comparison: statuses, renames, not truncated', async () => {
    const { p } = github([fixtureRoute('compare-ahead-200')]);
    const got = await p.compareCommits!(ctx, GH_REPO, 'aaaa111', 'bbbb222');
    expect(got.truncated).toBe(false);
    expect(got.files).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
      { path: 'src/gone.ts', status: 'removed' },
      { path: 'src/moved.ts', status: 'renamed', previousPath: 'src/old-name.ts' },
      { path: 'src/copy.ts', status: 'modified' },
    ]);
  });

  it('reports a base that is not an ancestor of head as truncated', async () => {
    const { p } = github([fixtureRoute('compare-diverged-200')]);
    const got = await p.compareCommits!(ctx, GH_REPO, 'aaaa111', 'bbbb222');
    expect(got.truncated).toBe(true);
  });

  it('pages to the 300-file cap and reports truncated', async () => {
    const url = `${GH}/repos/${GH_REPO}/compare/aaaa111...bbbb222?per_page=100`;
    const page = (from: number) => ({
      status: 'ahead',
      files: Array.from({ length: 100 }, (_, i) => rawFile(from + i)),
    });
    const { p, client } = github([
      { method: 'GET', url, response: { status: 200, body: page(0) } },
      { method: 'GET', url: `${url}&page=2`, response: { status: 200, body: page(100) } },
      { method: 'GET', url: `${url}&page=3`, response: { status: 200, body: page(200) } },
    ]);
    const got = await p.compareCommits!(ctx, GH_REPO, 'aaaa111', 'bbbb222');
    expect(got.files).toHaveLength(300);
    expect(got.truncated).toBe(true);
    expect(client.calls).toHaveLength(3);
  });

  it('stops at a short page and is not truncated below the cap', async () => {
    const url = `${GH}/repos/${GH_REPO}/compare/aaaa111...bbbb222?per_page=100`;
    const { p, client } = github([
      {
        method: 'GET',
        url,
        response: {
          status: 200,
          body: { status: 'ahead', files: Array.from({ length: 100 }, (_, i) => rawFile(i)) },
        },
      },
      {
        method: 'GET',
        url: `${url}&page=2`,
        response: { status: 200, body: { status: 'ahead', files: [rawFile(100)] } },
      },
    ]);
    const got = await p.compareCommits!(ctx, GH_REPO, 'aaaa111', 'bbbb222');
    expect(got.files).toHaveLength(101);
    expect(got.truncated).toBe(false);
    expect(client.calls).toHaveLength(2);
  });

  it('throws on an unknown base (404) so the planner falls back to full', async () => {
    const url = `${GH}/repos/${GH_REPO}/compare/dead...bbbb222?per_page=100`;
    const { p } = github([
      { method: 'GET', url, response: { status: 404, body: { message: 'Not Found' } } },
    ]);
    await expect(p.compareCommits!(ctx, GH_REPO, 'dead', 'bbbb222')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('getCommitTreeSha', () => {
  it('GitHub reads .tree.sha, and answers null for a missing commit', async () => {
    const { p } = github([
      {
        method: 'GET',
        url: `${GH}/repos/${GH_REPO}/git/commits/c1`,
        response: { status: 200, body: { sha: 'c1', tree: { sha: 'tree-1' } } },
      },
      {
        method: 'GET',
        url: `${GH}/repos/${GH_REPO}/git/commits/c2`,
        response: { status: 404, body: { message: 'Not Found' } },
      },
    ]);
    expect(await p.getCommitTreeSha!(ctx, GH_REPO, 'c1')).toBe('tree-1');
    expect(await p.getCommitTreeSha!(ctx, GH_REPO, 'c2')).toBeNull();
  });

  it('Gitea reads .commit.tree.sha; GitLab has none', async () => {
    const host = 'https://git.example.com';
    const gitea = new GiteaProvider({
      client: makeStubClient([
        {
          method: 'GET',
          url: `${host}/api/v1/repos/acme/widgets/git/commits/c1`,
          response: { status: 200, body: { sha: 'c1', commit: { tree: { sha: 'tree-g' } } } },
        },
      ]),
      auth,
      baseUrl: host,
    });
    expect(await gitea.getCommitTreeSha!(ctx, 'acme/widgets', 'c1')).toBe('tree-g');
    const gitlab = new GitLabProvider({ client: makeStubClient([]), auth, baseUrl: host });
    expect(await gitlab.getCommitTreeSha!(ctx, 'acme/widgets', 'c1')).toBeNull();
  });
});

describe('Gitea compareCommits', () => {
  const host = 'https://git.example.com';
  const api = `${host}/api/v1`;
  const compareUrl = `${api}/repos/acme/widgets/compare/b0...h0`;
  const commitUrl = (sha: string) => `${api}/repos/acme/widgets/git/commits/${sha}`;
  const commit = (sha: string, files: { filename: string; status: string }[]) => ({
    sha,
    commit: { message: 'm', author: null, committer: null },
    author: null,
    parents: [{ sha: 'p' }],
    files,
  });
  const gitea = (routes: StubRoute[]) =>
    new GiteaProvider({ client: makeStubClient(routes), auth, baseUrl: host });

  it('unions the commits files; the newest status per path wins', async () => {
    const p = gitea([
      {
        method: 'GET',
        url: compareUrl,
        response: {
          status: 200,
          body: { total_commits: 2, commits: [{ sha: 'c2', parents: [{ sha: 'c1' }] }, { sha: 'c1', parents: [{ sha: 'b0' }] }] },
        },
      },
      {
        method: 'GET',
        url: commitUrl('c1'),
        response: {
          status: 200,
          body: commit('c1', [
            { filename: 'a.ts', status: 'modified' },
            { filename: 'new.ts', status: 'added' },
            { filename: 'tmp.ts', status: 'added' },
          ]),
        },
      },
      {
        method: 'GET',
        url: commitUrl('c2'),
        response: {
          status: 200,
          body: commit('c2', [
            { filename: 'new.ts', status: 'modified' },
            { filename: 'tmp.ts', status: 'removed' },
          ]),
        },
      },
    ]);
    const got = await p.compareCommits!(ctx, 'acme/widgets', 'b0', 'h0');
    expect(got.truncated).toBe(false);
    const by = Object.fromEntries(got.files.map((f) => [f.path, f.status]));
    expect(by).toEqual({ 'a.ts': 'modified', 'new.ts': 'added', 'tmp.ts': 'removed' });
  });

  it('a merge commit in the range is truncated (its files are not listed)', async () => {
    const p = gitea([
      {
        method: 'GET',
        url: compareUrl,
        response: {
          status: 200,
          body: { total_commits: 1, commits: [{ sha: 'm1', parents: [{ sha: 'x' }, { sha: 'y' }] }] },
        },
      },
    ]);
    expect(await p.compareCommits!(ctx, 'acme/widgets', 'b0', 'h0')).toEqual({
      files: [],
      truncated: true,
    });
  });

  it('a range over the commit cap is truncated without fetching commits', async () => {
    const p = gitea([
      {
        method: 'GET',
        url: compareUrl,
        response: { status: 200, body: { total_commits: 400, commits: [{ sha: 'c', parents: [] }] } },
      },
    ]);
    expect((await p.compareCommits!(ctx, 'acme/widgets', 'b0', 'h0')).truncated).toBe(true);
  });
});

describe('GitLab compareCommits', () => {
  const host = 'https://gitlab.example.com';
  const url = `${host}/api/v4/projects/acme%2Fwidgets/repository/compare?from=b0&to=h0&straight=true`;
  const gitlab = (body: unknown) =>
    new GitLabProvider({
      client: makeStubClient([{ method: 'GET', url, response: { status: 200, body } }]),
      auth,
      baseUrl: host,
    });

  it('maps diffs (new, deleted, renamed, modified) and is exact', async () => {
    const got = await gitlab({
      compare_timeout: false,
      diffs: [
        { old_path: 'a.ts', new_path: 'a.ts', diff: '@@' },
        { old_path: 'n.ts', new_path: 'n.ts', new_file: true, diff: '@@' },
        { old_path: 'd.ts', new_path: 'd.ts', deleted_file: true, diff: '@@' },
        { old_path: 'o.ts', new_path: 'r.ts', renamed_file: true, diff: '' },
      ],
    }).compareCommits!(ctx, 'acme/widgets', 'b0', 'h0');
    expect(got.truncated).toBe(false);
    expect(got.files).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'n.ts', status: 'added' },
      { path: 'd.ts', status: 'removed' },
      { path: 'r.ts', status: 'renamed', previousPath: 'o.ts' },
    ]);
  });

  it('compare_timeout and the file limit are truncated', async () => {
    expect(
      (await gitlab({ compare_timeout: true, diffs: [] }).compareCommits!(ctx, 'acme/widgets', 'b0', 'h0'))
        .truncated,
    ).toBe(true);
    const many = Array.from({ length: 1000 }, (_, i) => ({ old_path: `f${i}`, new_path: `f${i}`, diff: '' }));
    expect(
      (await gitlab({ diffs: many }).compareCommits!(ctx, 'acme/widgets', 'b0', 'h0')).truncated,
    ).toBe(true);
  });
});
