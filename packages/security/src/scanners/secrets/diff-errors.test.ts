import { describe, expect, it } from 'vitest';
import {
  GitHubProvider,
  createAuthHeaderProvider,
  type ForgeHttpClient,
  type ForgeResponse,
} from '@repopulse/forge';
import { diffOf } from './stream.js';

// W17-38 (R-15): a secrets scan reads the diff through getPullRequestFiles /
// getCommitFiles. Those used to read a 403 as an empty diff, so the scan run
// closed 'succeeded, 0 findings' over files it never saw. diffOf must reject,
// which scanOneTarget's catch turns into a FAILED scan_run (NFR-15: the job the
// scan rides on is not failed).

function githubAnswering(status: number, body: unknown): GitHubProvider {
  const client: ForgeHttpClient = {
    request: (): Promise<ForgeResponse> =>
      Promise.resolve({ status, headers: {}, body, servedFromCache: false }),
  };
  return new GitHubProvider({
    client,
    auth: createAuthHeaderProvider({ kind: 'pat', token: 'w17-38-diff' }),
  });
}

const deps = (provider: GitHubProvider) => ({ provider, repo: 'acme/widgets', repoId: 1 });
const DENIED = { message: 'Resource not accessible by personal access token' };

describe('secrets diff fetch does not read a refusal as an empty diff (W17-38)', () => {
  it('rejects on a 403 for a PR diff', async () => {
    await expect(
      diffOf(deps(githubAnswering(403, DENIED)), { commitSha: 'abc', prNumber: 4 }),
    ).rejects.toMatchObject({ status: 403, entity: 'pr_files' });
  });

  it('rejects on a 404 for a commit diff', async () => {
    await expect(
      diffOf(deps(githubAnswering(404, { message: 'Not Found' })), { commitSha: 'abc' }),
    ).rejects.toMatchObject({ status: 404, entity: 'commit_files' });
  });
});
