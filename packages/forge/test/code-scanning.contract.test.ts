import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { GiteaProvider } from '../src/gitea/provider.js';
import { GitLabProvider } from '../src/gitlab/provider.js';
import { ForgeHttpError } from '../src/client/errors.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// GitHub code-scanning alerts (W18-24): a READ-ONLY pull of another scanner's
// open alerts. What this contract pins: the request is a GET for open alerts
// only, it paginates by Link header like every other GitHub list, and a missing
// permission (403) or a repository without code scanning (404) REJECTS — read
// as an empty page, either would tell the pull "no alerts" and its sweep would
// then close every alert it had imported last time.

const ctx: CallCtx = { lane: 'scan' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'code_scanning_contract' });
const REPO = 'acme/widgets';
const URL1 = `https://api.github.com/repos/${REPO}/code-scanning/alerts?state=open&per_page=100`;

const github = (routes: StubRoute[]) => {
  const client = makeStubClient(routes);
  return { client, provider: new GitHubProvider({ client, auth }) };
};

// Shape from the published REST reference for "List code scanning alerts for a
// repository" — trimmed to the fields the normaliser reads plus a few it
// ignores, so an unexpected extra field is proven harmless.
const ALERT = {
  number: 42,
  state: 'open',
  html_url: 'https://github.com/acme/widgets/security/code-scanning/42',
  created_at: '2026-09-01T10:00:00Z',
  rule: {
    id: 'js/sql-injection',
    name: 'js/sql-injection',
    description: 'Database query built from user-controlled sources',
    severity: 'error',
    security_severity_level: 'high',
    tags: ['security', 'external/cwe/cwe-089'],
  },
  tool: { name: 'CodeQL', version: '2.19.0', guid: null },
  most_recent_instance: {
    ref: 'refs/heads/main',
    analysis_key: '.github/workflows/codeql.yml:analyze',
    commit_sha: 'a'.repeat(40),
    state: 'open',
    location: { path: 'src/db.js', start_line: 17, end_line: 19, start_column: 3, end_column: 40 },
    message: { text: 'This query depends on a user-provided value.' },
  },
};

describe('GitHub code-scanning alerts (W18-24)', () => {
  it('declares the capability; GitLab and Gitea do not', () => {
    const { provider } = github([]);
    expect(provider.capabilities.supportsCodeScanningAlerts).toBe(true);
    const gitea = new GiteaProvider({
      client: makeStubClient([]),
      auth,
      baseUrl: 'https://git.example.com',
    });
    const gitlab = new GitLabProvider({
      client: makeStubClient([]),
      auth,
      baseUrl: 'https://gl.example.com',
    });
    // Declared false on both (the capability gate wants every key explicit).
    expect(gitea.capabilities.supportsCodeScanningAlerts).toBe(false);
    expect(gitlab.capabilities.supportsCodeScanningAlerts).toBe(false);
  });

  it('GETs open alerts only and normalises them', async () => {
    const { client, provider } = github([
      { method: 'GET', url: URL1, response: { status: 200, body: [ALERT] } },
    ]);
    const page = await provider.listCodeScanningAlerts(ctx, REPO);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe('GET');
    expect(page.nextCursor).toBeUndefined();
    expect(page.items).toEqual([
      {
        number: 42,
        state: 'open',
        ruleId: 'js/sql-injection',
        ruleName: 'js/sql-injection',
        ruleDescription: 'Database query built from user-controlled sources',
        ruleSeverity: 'error',
        securitySeverityLevel: 'high',
        ruleTags: ['security', 'external/cwe/cwe-089'],
        toolName: 'CodeQL',
        toolVersion: '2.19.0',
        path: 'src/db.js',
        startLine: 17,
        endLine: 19,
        message: 'This query depends on a user-provided value.',
        commitSha: 'a'.repeat(40),
        htmlUrl: 'https://github.com/acme/widgets/security/code-scanning/42',
      },
    ]);
  });

  it('follows the Link header to the next page', async () => {
    const { provider } = github([
      {
        method: 'GET',
        url: URL1,
        response: {
          status: 200,
          headers: { link: `<${URL1}&page=2>; rel="next", <${URL1}&page=2>; rel="last"` },
          body: [ALERT],
        },
      },
      { method: 'GET', url: `${URL1}&page=2`, response: { status: 200, body: [] } },
    ]);
    const first = await provider.listCodeScanningAlerts(ctx, REPO);
    expect(first.nextCursor).toBe('2');
    const second = await provider.listCodeScanningAlerts(ctx, REPO, first.nextCursor);
    expect(second.items).toEqual([]);
  });

  it('a location-less alert is repo-level, never line 1', async () => {
    const bare = {
      number: 7,
      rule: { id: 'r' },
      tool: { name: 'Trivy' },
      most_recent_instance: {},
    };
    const { provider } = github([
      { method: 'GET', url: URL1, response: { status: 200, body: [bare] } },
    ]);
    const [alert] = (await provider.listCodeScanningAlerts(ctx, REPO)).items;
    expect(alert).toMatchObject({ path: null, startLine: null, endLine: null, toolVersion: null });
  });

  it('a missing permission rejects with 403 instead of reading as "no alerts"', async () => {
    const { provider } = github([
      {
        method: 'GET',
        url: URL1,
        response: { status: 403, body: { message: 'Resource not accessible by integration' } },
      },
    ]);
    const err = await provider.listCodeScanningAlerts(ctx, REPO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForgeHttpError);
    expect(err).toMatchObject({ status: 403, entity: 'code_scanning_alerts' });
  });

  it('code scanning switched off rejects with 404', async () => {
    const { provider } = github([
      {
        method: 'GET',
        url: URL1,
        response: { status: 404, body: { message: 'no analysis found' } },
      },
    ]);
    await expect(provider.listCodeScanningAlerts(ctx, REPO)).rejects.toMatchObject({
      status: 404,
    });
  });
});
