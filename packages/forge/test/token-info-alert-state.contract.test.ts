import { describe, expect, it } from 'vitest';
import { createAuthHeaderProvider } from '../src/github/auth.js';
import { GitHubProvider } from '../src/github/provider.js';
import { GiteaProvider } from '../src/gitea/provider.js';
import { GitLabProvider } from '../src/gitlab/provider.js';
import { ForgeHttpError } from '../src/client/errors.js';
import { makeStubClient } from './stub-client.js';
import type { CallCtx } from '../src/types.js';

// W20-25. Two reads, both GET only:
//   ADM-50: the token's owner and expiry, where each forge reports them.
//   FND-63: dismissed and fixed code-scanning alerts, with who and why.

const ctx: CallCtx = { lane: 'user' };
const auth = createAuthHeaderProvider({ kind: 'pat', token: 'token_info_contract' });

describe('getTokenInfo (W20-25, ADM-50)', () => {
  it('GitHub: login from /user, expiry from the token-expiration header', async () => {
    const client = makeStubClient([
      {
        method: 'GET',
        url: 'https://api.github.com/user',
        response: {
          status: 200,
          headers: { 'github-authentication-token-expiration': '2026-11-30 12:00:00 UTC' },
          body: { login: 'ada', id: 1 },
        },
      },
    ]);
    const info = await new GitHubProvider({ client, auth }).getTokenInfo(ctx);
    expect(info.ownerLogin).toBe('ada');
    expect(info.expiresAt?.toISOString()).toBe('2026-11-30T12:00:00.000Z');
    expect(client.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('GitHub: no header means no expiry; a refusal throws', async () => {
    const ok = makeStubClient([
      {
        method: 'GET',
        url: 'https://api.github.com/user',
        response: { status: 200, body: { login: 'ada' } },
      },
    ]);
    expect((await new GitHubProvider({ client: ok, auth }).getTokenInfo(ctx)).expiresAt).toBeNull();
    const refused = makeStubClient([
      {
        method: 'GET',
        url: 'https://api.github.com/user',
        response: { status: 403, body: { message: 'Resource not accessible by integration' } },
      },
    ]);
    await expect(
      new GitHubProvider({ client: refused, auth }).getTokenInfo(ctx),
    ).rejects.toBeInstanceOf(ForgeHttpError);
  });

  it('GitLab: username from /user, expires_at from the personal-token self lookup', async () => {
    const client = makeStubClient([
      {
        method: 'GET',
        url: 'https://gl.example.com/api/v4/user',
        response: { status: 200, body: { id: 7, username: 'grace' } },
      },
      {
        method: 'GET',
        url: 'https://gl.example.com/api/v4/personal_access_tokens/self',
        response: { status: 200, body: { id: 3, user_id: 7, expires_at: '2026-12-31' } },
      },
    ]);
    const info = await new GitLabProvider({
      client,
      auth,
      baseUrl: 'https://gl.example.com',
    }).getTokenInfo(ctx);
    expect(info).toEqual({ ownerLogin: 'grace', expiresAt: new Date('2026-12-31T00:00:00Z') });
  });

  it('GitLab: an instance without the self lookup still gives the owner', async () => {
    const client = makeStubClient([
      {
        method: 'GET',
        url: 'https://gl.example.com/api/v4/user',
        response: { status: 200, body: { username: 'grace' } },
      },
      {
        method: 'GET',
        url: 'https://gl.example.com/api/v4/personal_access_tokens/self',
        response: { status: 404, body: { message: '404 Not Found' } },
      },
    ]);
    const info = await new GitLabProvider({
      client,
      auth,
      baseUrl: 'https://gl.example.com',
    }).getTokenInfo(ctx);
    expect(info).toEqual({ ownerLogin: 'grace', expiresAt: null });
  });

  it('Gitea: login only (Gitea tokens do not expire)', async () => {
    const client = makeStubClient([
      {
        method: 'GET',
        url: 'https://git.example.com/api/v1/user',
        response: { status: 200, body: { login: 'linus' } },
      },
    ]);
    const info = await new GiteaProvider({
      client,
      auth,
      baseUrl: 'https://git.example.com',
    }).getTokenInfo(ctx);
    expect(info).toEqual({ ownerLogin: 'linus', expiresAt: null });
  });
});

describe('dismissed and fixed code-scanning alerts (W20-25, FND-63)', () => {
  it('GETs one state at a time, most recently updated first, with who and why', async () => {
    const url =
      'https://api.github.com/repos/acme/widgets/code-scanning/alerts?state=dismissed&sort=updated&direction=desc&per_page=100';
    const client = makeStubClient([
      {
        method: 'GET',
        url,
        response: {
          status: 200,
          body: [
            {
              number: 9,
              state: 'dismissed',
              rule: { id: 'js/xss' },
              tool: { name: 'CodeQL' },
              dismissed_by: { login: 'ada' },
              dismissed_reason: 'false positive',
              dismissed_comment: 'sanitised upstream',
              dismissed_at: '2026-10-01T00:00:00Z',
              fixed_at: null,
            },
          ],
        },
      },
    ]);
    const page = await new GitHubProvider({ client, auth }).listCodeScanningAlerts(
      { lane: 'scan' },
      'acme/widgets',
      undefined,
      { state: 'dismissed' },
    );
    expect(client.calls).toEqual([expect.objectContaining({ method: 'GET', url })]);
    expect(page.items[0]).toMatchObject({
      state: 'dismissed',
      dismissedBy: 'ada',
      dismissedReason: 'false positive',
      dismissedComment: 'sanitised upstream',
      dismissedAt: '2026-10-01T00:00:00Z',
      fixedAt: null,
    });
  });
});
