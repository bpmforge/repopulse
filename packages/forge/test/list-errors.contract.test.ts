import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { GiteaProvider } from '../src/gitea/provider.js';
import { GitLabProvider } from '../src/gitlab/provider.js';
import { ForgeHttpError } from '../src/client/errors.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// Backfill list calls must not turn an HTTP error into an empty page (W17-35).
//
// Found against a real Gitea 1.24.7 on 2026-09-23: a read-only token got 403
// on /issues, every adapter's list helper read the non-array error body as
// "zero items", the entity checkpointed backfill_done, and the repo went live
// with no record that issues were never ingested. Each case below is the
// response shape that produced that silence, per forge.

const ctx: CallCtx = { lane: 'backfill' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'list_errors_contract' });
const REPO = 'acme/widgets';

const gitea = (routes: StubRoute[]) =>
  new GiteaProvider({ client: makeStubClient(routes), auth, baseUrl: 'https://git.example.com' });
const github = (routes: StubRoute[]) =>
  new GitHubProvider({ client: makeStubClient(routes), auth });
const gitlab = (routes: StubRoute[]) =>
  new GitLabProvider({ client: makeStubClient(routes), auth, baseUrl: 'https://gl.example.com' });

const GITEA_ISSUES = `https://git.example.com/api/v1/repos/${REPO}/issues?state=all&type=issues&page=1&limit=50`;
const GITEA_COMMITS = `https://git.example.com/api/v1/repos/${REPO}/commits?page=1&limit=50`;
const GITHUB_ISSUES = `https://api.github.com/repos/${REPO}/issues?state=all&per_page=100`;
const GITHUB_COMMITS = `https://api.github.com/repos/${REPO}/commits?per_page=100`;
const GITLAB_ISSUES = `https://gl.example.com/api/v4/projects/acme%2Fwidgets/issues?state=all&page=1&per_page=100`;

describe('list calls surface HTTP errors instead of reading them as empty (W17-35)', () => {
  it('Gitea: a 403 on issues rejects with ForgeHttpError carrying the status', async () => {
    const p = gitea([
      {
        method: 'GET',
        url: GITEA_ISSUES,
        response: {
          status: 403,
          body: { message: 'token does not have at least one of required scope(s): [read:issue]' },
        },
      },
    ]);
    const err = await p.listIssues(ctx, REPO, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeHttpError);
    expect(err).toMatchObject({ status: 403, entity: 'issues' });
    expect((err as Error).message).toContain('read:issue');
  });

  it('GitHub: a 403 on issues rejects with ForgeHttpError', async () => {
    const p = github([
      {
        method: 'GET',
        url: GITHUB_ISSUES,
        response: {
          status: 403,
          body: { message: 'Resource not accessible by personal access token' },
        },
      },
    ]);
    await expect(p.listIssues(ctx, REPO, {})).rejects.toMatchObject({
      status: 403,
      entity: 'issues',
    });
  });

  it('GitLab: a 403 on issues rejects with ForgeHttpError', async () => {
    const p = gitlab([
      {
        method: 'GET',
        url: GITLAB_ISSUES,
        response: { status: 403, body: { message: '403 Forbidden' } },
      },
    ]);
    await expect(p.listIssues(ctx, REPO, {})).rejects.toMatchObject({
      status: 403,
      entity: 'issues',
    });
  });

  it('a 5xx that survived the client retries also rejects rather than reading as empty', async () => {
    const p = gitea([
      { method: 'GET', url: GITEA_ISSUES, response: { status: 502, body: 'bad gateway' } },
    ]);
    await expect(p.listIssues(ctx, REPO, {})).rejects.toMatchObject({ status: 502 });
  });

  it('listRepos rejects on 401, so a bad token cannot connect as "0 repositories"', async () => {
    const p = gitea([
      {
        method: 'GET',
        url: 'https://git.example.com/api/v1/user/repos?page=1&limit=50',
        response: { status: 401, body: { message: 'user does not exist' } },
      },
    ]);
    // connect.ts classifies smoke failures by `.status` — this is the shape it expects.
    await expect(p.listRepos(ctx)).rejects.toMatchObject({ status: 401 });
  });

  // An EMPTY repository is not an error: both forges answer 409 on /commits
  // for a repo with no commits yet. That must stay an empty, finished page.
  it('Gitea: 409 on commits (empty repository) is an empty last page', async () => {
    const p = gitea([
      {
        method: 'GET',
        url: GITEA_COMMITS,
        response: { status: 409, body: { message: 'Git Repository is empty.' } },
      },
    ]);
    await expect(p.listCommits(ctx, REPO, {})).resolves.toEqual({ items: [] });
  });

  it('GitHub: 409 on commits (empty repository) is an empty last page', async () => {
    const p = github([
      {
        method: 'GET',
        url: GITHUB_COMMITS,
        response: { status: 409, body: { message: 'Git Repository is empty.' } },
      },
    ]);
    await expect(p.listCommits(ctx, REPO, {})).resolves.toEqual({ items: [] });
  });
});
