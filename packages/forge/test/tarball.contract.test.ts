import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { GiteaProvider } from '../src/gitea/provider.js';
import { GitLabProvider } from '../src/gitlab/provider.js';
import { makeStubClient, type StubRoute } from './stub-client.js';
import { TarballError, resolveTarball } from '../src/client/tarball.js';
import { ConcurrencyQueue } from '../src/client/concurrency-queue.js';
import type { CallCtx } from '../src/types.js';

// Tarball op + scan lane (W8-03, SECURITY_SUITE.md 1.4, C1a exception).

const API = 'https://api.github.com';
const REPO = 'bpmforge/repopulse-fixture';
const SHA = 'a'.repeat(40);
const ctx: CallCtx = { lane: 'scan' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'ghp_tarball_test' });
const CODELOAD = `https://codeload.github.com/${REPO}/legacy.tar.gz/${SHA}?token=signed`;

type Download = (url: string) => Promise<{ status: number; bytes: Uint8Array }>;

function githubProvider(routes: StubRoute[], download: Download) {
  const client = makeStubClient(routes);
  return { client, provider: new GitHubProvider({ client, auth, tarballDownloader: download }) };
}

const redirect: StubRoute = {
  method: 'GET',
  url: `${API}/repos/${REPO}/tarball/${SHA}`,
  response: { status: 302, headers: { location: CODELOAD }, body: '' },
};

describe('getTarball (W8-03, C1a)', () => {
  it('follows the 302 to codeload and returns the bytes', async () => {
    const seen: string[] = [];
    const { provider } = githubProvider([redirect], async (url) => {
      seen.push(url);
      return { status: 200, bytes: new Uint8Array([31, 139, 8, 0]) };
    });

    const tarball = await provider.getTarball(ctx, REPO, SHA);
    expect(seen).toEqual([CODELOAD]);
    expect(tarball.commitSha).toBe(SHA);
    expect(tarball.sourceHost).toBe('codeload.github.com');
    expect(tarball.bytes.byteLength).toBe(4);
  });

  it('does NOT carry the forge token to codeload', async () => {
    // The signature in the redirect URL is the credential. Forwarding a forge
    // token to a host the connection was never scoped to is a credential egress
    // with no purpose - and the downloader's signature is the structural
    // guarantee: it takes a URL and nothing else, so there is no header to
    // leak. This test pins that shape.
    let leaked = false;
    const { client, provider } = githubProvider([redirect], async (url) => {
      leaked = url.toLowerCase().includes('ghp_') || url.toLowerCase().includes('authorization');
      return { status: 200, bytes: new Uint8Array([1]) };
    });
    await provider.getTarball(ctx, REPO, SHA);
    expect(leaked).toBe(false);
    // The API call itself IS authenticated - that half must not regress either.
    expect(client.calls[0]?.headers['authorization']).toContain('ghp_tarball_test');
  });

  it('refuses a redirect to a host that is not codeload', async () => {
    // A redirect is an instruction from a remote server about where to send the
    // next request. Following it anywhere is how an SSRF becomes a download.
    const { provider } = githubProvider(
      [
        {
          method: 'GET',
          url: `${API}/repos/${REPO}/tarball/${SHA}`,
          response: {
            status: 302,
            headers: { location: 'https://evil.example/x.tar.gz' },
            body: '',
          },
        },
      ],
      async () => {
        throw new Error('downloader must never be called for a disallowed host');
      },
    );
    await expect(provider.getTarball(ctx, REPO, SHA)).rejects.toThrow(/unexpected host/);
  });

  it('spends exactly one core point, like any other REST GET', async () => {
    const { client, provider } = githubProvider([redirect], async () => ({
      status: 200,
      bytes: new Uint8Array([1]),
    }));
    await provider.getTarball(ctx, REPO, SHA);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.url).toBe(`${API}/repos/${REPO}/tarball/${SHA}`);
  });

  it('Gitea answers with bytes and no redirect at all', async () => {
    const client = makeStubClient([
      {
        method: 'GET',
        url: `https://git.example.com/api/v1/repos/${REPO}/archive/${SHA}.tar.gz`,
        response: { status: 200, body: new Uint8Array([31, 139]) },
      },
    ]);
    const gitea = new GiteaProvider({ client, auth, baseUrl: 'https://git.example.com/api/v1' });
    expect(gitea.capabilities.supportsTarball).toBe(true);
    const tarball = await gitea.getTarball(ctx, REPO, SHA);
    expect(tarball.bytes.byteLength).toBe(2);
    expect(tarball.sourceHost).toBe('git.example.com');
  });

  it('GitLab says it cannot, rather than returning an empty archive', async () => {
    // An empty snapshot would scan clean and report the repo as having no
    // findings - the most dangerous thing a security subsystem can say.
    const gitlab = new GitLabProvider({ client: makeStubClient([]), auth });
    expect(gitlab.capabilities.supportsTarball).toBe(false);
    await expect(gitlab.getTarball(ctx, REPO, SHA)).rejects.toThrow(/supportsTarball/);
  });

  it('a body the transport decoded as text is an error, not a corrupt archive', async () => {
    // Re-encoding a decoded string would produce a tar that fails to parse a
    // long way from the cause.
    await expect(
      resolveTarball({
        commitSha: SHA,
        apiHost: 'api.github.com',
        status: 200,
        headers: {},
        body: 'PK not really bytes',
        download: async () => ({ status: 200, bytes: new Uint8Array([1]) }),
      }),
    ).rejects.toThrow(TarballError);
  });
});

describe('the scan lane (W8-03)', () => {
  it('outranks reconcile and yields to backfill', async () => {
    // A scan is worth less than filling in history someone asked for and more
    // than catching up on data we already have - a scan queued behind reconcile
    // would never run on a busy workspace.
    const queue = new ConcurrencyQueue(1);
    const held = await queue.acquire('user');
    const order: string[] = [];
    const reconcile = queue.acquire('reconcile').then((r) => {
      order.push('reconcile');
      r();
    });
    const scan = queue.acquire('scan').then((r) => {
      order.push('scan');
      r();
    });
    const backfill = queue.acquire('backfill').then((r) => {
      order.push('backfill');
      r();
    });
    held();
    await Promise.all([reconcile, scan, backfill]);
    expect(order).toEqual(['backfill', 'scan', 'reconcile']);
  });

  it('reports scan depth, so a parked scan is visible in metrics', () => {
    const queue = new ConcurrencyQueue(1);
    expect(queue.queueDepth).toEqual({ webhook: 0, user: 0, backfill: 0, scan: 0, reconcile: 0 });
  });
});
