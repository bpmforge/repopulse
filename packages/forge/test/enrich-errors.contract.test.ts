import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { GiteaProvider } from '../src/gitea/provider.js';
import { GitLabProvider } from '../src/gitlab/provider.js';
import { ForgeHttpError } from '../src/client/errors.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// Enrichment fetches must not turn an HTTP error into "nothing here" (W17-38,
// residual R-15 of W17-35).
//
// W17-35 made the five backfill lists reject; the per-PR and per-commit detail
// fetches were left lenient. So a token without the checks scope stamped every
// PR "enriched, zero check runs", a 404 on a commit recorded zero churn as if it
// had been measured, and a 403 on a PR's files let a scanner report
// "succeeded, 0 findings" over a diff it never saw.

const ctx: CallCtx = { lane: 'reconcile' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'enrich_errors_contract' });
const REPO = 'acme/widgets';
const SHA = 'abc123';

const gitea = (routes: StubRoute[]) =>
  new GiteaProvider({ client: makeStubClient(routes), auth, baseUrl: 'https://git.example.com' });
const github = (routes: StubRoute[]) =>
  new GitHubProvider({ client: makeStubClient(routes), auth });
const gitlab = (routes: StubRoute[]) =>
  new GitLabProvider({ client: makeStubClient(routes), auth, baseUrl: 'https://gl.example.com' });

const get = (url: string, status: number, body: unknown): StubRoute => ({
  method: 'GET',
  url,
  response: { status, body },
});

const GH = `https://api.github.com/repos/${REPO}`;
const GT = `https://git.example.com/api/v1/repos/${REPO}`;
const GL = `https://gl.example.com/api/v4/projects/acme%2Fwidgets`;
const SCOPE = { message: 'Resource not accessible by personal access token' };

describe('enrichment fetches surface HTTP errors instead of reading them as empty (W17-38)', () => {
  it('GitHub: a 403 on check runs rejects, naming the entity', async () => {
    const p = github([get(`${GH}/commits/${SHA}/check-runs?per_page=100`, 403, SCOPE)]);
    const err = await p.listCheckRuns(ctx, REPO, { headSha: SHA }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeHttpError);
    expect(err).toMatchObject({ status: 403, entity: 'checks' });
  });

  it('GitHub: a 403 on reviews rejects', async () => {
    const p = github([get(`${GH}/pulls/7/reviews?per_page=100`, 403, SCOPE)]);
    await expect(p.listReviews(ctx, REPO, 7)).rejects.toMatchObject({
      status: 403,
      entity: 'reviews',
    });
  });

  it('GitHub: a 404 on PR files rejects', async () => {
    const p = github([get(`${GH}/pulls/7/files?per_page=100`, 404, { message: 'Not Found' })]);
    await expect(p.getPullRequestFiles(ctx, REPO, 7)).rejects.toMatchObject({
      status: 404,
      entity: 'pr_files',
    });
  });

  it('GitHub: a 422 on a commit (no such SHA) rejects instead of recording zero churn', async () => {
    const p = github([
      get(`${GH}/commits/${SHA}?per_page=100`, 422, { message: 'No commit found for SHA' }),
    ]);
    await expect(p.getCommitFiles(ctx, REPO, SHA)).rejects.toMatchObject({
      status: 422,
      entity: 'commit_files',
    });
  });

  it('Gitea: a 403 on reviews rejects', async () => {
    const p = gitea([get(`${GT}/pulls/7/reviews`, 403, SCOPE)]);
    await expect(p.listReviews(ctx, REPO, 7)).rejects.toMatchObject({
      status: 403,
      entity: 'reviews',
    });
  });

  it('Gitea: a 502 on commit statuses rejects (retryable, not "no CI")', async () => {
    const p = gitea([get(`${GT}/commits/${SHA}/statuses?page=1&limit=50`, 502, 'bad gateway')]);
    const err = await p.listCheckRuns(ctx, REPO, { headSha: SHA }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, entity: 'checks' });
    expect((err as ForgeHttpError).permanent).toBe(false);
  });

  it('Gitea: a 404 on PR files and on a commit reject', async () => {
    const p = gitea([
      get(`${GT}/pulls/7/files?page=1&limit=50`, 404, { message: 'not found' }),
      get(`${GT}/git/commits/${SHA}`, 404, { message: 'not found' }),
    ]);
    await expect(p.getPullRequestFiles(ctx, REPO, 7)).rejects.toMatchObject({
      status: 404,
      entity: 'pr_files',
    });
    await expect(p.getCommitFiles(ctx, REPO, SHA)).rejects.toMatchObject({
      status: 404,
      entity: 'commit_files',
    });
  });

  it('GitLab: a 403 on approvals, pipelines, MR diffs and commit detail rejects', async () => {
    const p = gitlab([
      get(`${GL}/merge_requests/7/approvals`, 403, { message: '403 Forbidden' }),
      get(`${GL}/pipelines?sha=${SHA}&page=1&per_page=100`, 403, { message: '403 Forbidden' }),
      get(`${GL}/merge_requests/7/diffs?page=1&per_page=100`, 403, { message: '403 Forbidden' }),
      get(`${GL}/repository/commits/${SHA}`, 403, { message: '403 Forbidden' }),
    ]);
    await expect(p.listReviews(ctx, REPO, 7)).rejects.toMatchObject({ entity: 'reviews' });
    await expect(p.listCheckRuns(ctx, REPO, { headSha: SHA })).rejects.toMatchObject({
      entity: 'checks',
    });
    await expect(p.getPullRequestFiles(ctx, REPO, 7)).rejects.toMatchObject({
      entity: 'pr_files',
    });
    await expect(p.getCommitFiles(ctx, REPO, SHA)).rejects.toMatchObject({
      entity: 'commit_files',
    });
  });

  it('a 2xx still resolves normally (the check is not a blanket reject)', async () => {
    const p = github([
      get(`${GH}/commits/${SHA}/check-runs?per_page=100`, 200, { total_count: 0, check_runs: [] }),
      get(`${GH}/pulls/7/reviews?per_page=100`, 200, []),
    ]);
    await expect(p.listCheckRuns(ctx, REPO, { headSha: SHA })).resolves.toEqual({ items: [] });
    await expect(p.listReviews(ctx, REPO, 7)).resolves.toEqual([]);
  });
});
