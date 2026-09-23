import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { GiteaProvider } from '../src/gitea/provider.js';
import { GitLabProvider } from '../src/gitlab/provider.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// W17-39 (residual R-16): a feature switched OFF on a repository must read as
// "not enabled", not as an error — and the HTTP answer cannot say which it is.
// Observed live on 2026-09-23:
//   - GitHub, has_issues=false (torvalds/linux, git/git): GET /issues answers
//     200 — empty, or pull requests only; a single issue answers 410.
//   - Gitea 1.24.7, has_issues/has_pull_requests=false: /issues and /pulls
//     answer 404 "The target couldn't be found." — the same 404 as a missing
//     repo or no access. /releases with has_releases=false answers 200 [].
// So the repo METADATA is the discriminator. getRepo carries the flags; a flag
// the forge did not send stays undefined ("unknown"), never false.

const ctx: CallCtx = { lane: 'backfill' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'repo_features_contract' });
const REPO = 'acme/widgets';

const ok = (url: string, body: unknown): StubRoute => ({
  method: 'GET',
  url,
  response: { status: 200, body },
});

const GH_REPO = {
  id: 1,
  name: 'widgets',
  full_name: REPO,
  default_branch: 'main',
  private: false,
  archived: false,
  pushed_at: null,
  html_url: 'https://github.com/acme/widgets',
};
const GT_REPO = { ...GH_REPO, html_url: 'https://git.example.com/acme/widgets' };
const GL_PROJECT = {
  id: 9,
  name: 'widgets',
  path_with_namespace: REPO,
  default_branch: 'main',
  visibility: 'private',
  archived: false,
  last_activity_at: null,
  web_url: 'https://gl.example.com/acme/widgets',
};

describe('getRepo reports which features the repository has switched off (W17-39)', () => {
  it('GitHub: has_issues=false', async () => {
    const p = new GitHubProvider({
      client: makeStubClient([
        ok(`https://api.github.com/repos/${REPO}`, { ...GH_REPO, has_issues: false }),
      ]),
      auth,
    });
    expect((await p.getRepo(ctx, REPO)).features).toMatchObject({ issues: false });
  });

  it('Gitea: has_issues, has_pull_requests, has_releases (1.24.7 shape)', async () => {
    const p = new GiteaProvider({
      client: makeStubClient([
        ok(`https://git.example.com/api/v1/repos/${REPO}`, {
          ...GT_REPO,
          has_issues: false,
          has_pull_requests: false,
          has_releases: true,
        }),
      ]),
      auth,
      baseUrl: 'https://git.example.com',
    });
    expect((await p.getRepo(ctx, REPO)).features).toEqual({
      issues: false,
      pullRequests: false,
      releases: true,
    });
  });

  it('GitLab: *_access_level "disabled", and the older issues_enabled=false', async () => {
    const url = 'https://gl.example.com/api/v4/projects/acme%2Fwidgets';
    const levels = new GitLabProvider({
      client: makeStubClient([
        ok(url, {
          ...GL_PROJECT,
          issues_access_level: 'disabled',
          merge_requests_access_level: 'enabled',
          releases_access_level: 'disabled',
        }),
      ]),
      auth,
      baseUrl: 'https://gl.example.com',
    });
    expect((await levels.getRepo(ctx, REPO)).features).toEqual({
      issues: false,
      pullRequests: true,
      releases: false,
    });

    const legacy = new GitLabProvider({
      client: makeStubClient([ok(url, { ...GL_PROJECT, issues_enabled: false })]),
      auth,
      baseUrl: 'https://gl.example.com',
    });
    expect((await legacy.getRepo(ctx, REPO)).features?.issues).toBe(false);
  });

  it('a flag the forge did not send is unknown, not "disabled"', async () => {
    const p = new GitHubProvider({
      client: makeStubClient([ok(`https://api.github.com/repos/${REPO}`, GH_REPO)]),
      auth,
    });
    expect((await p.getRepo(ctx, REPO)).features?.issues).toBeUndefined();
  });

  it('getRepo rejects on an HTTP error instead of normalizing the error body', async () => {
    const p = new GiteaProvider({
      client: makeStubClient([
        {
          method: 'GET',
          url: `https://git.example.com/api/v1/repos/${REPO}`,
          response: { status: 404, body: { message: "The target couldn't be found." } },
        },
      ]),
      auth,
      baseUrl: 'https://git.example.com',
    });
    await expect(p.getRepo(ctx, REPO)).rejects.toMatchObject({ status: 404, entity: 'repo' });
  });
});
