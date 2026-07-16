import type { GithubOAuthConfig } from './config.js';

// Real GitHub endpoints, overridable per-call so tests can point at a
// mocked GitHub instead (SECURITY_CONTROLS.md SC-12/AC-4: this base URL is
// a fixed literal, never attacker/admin-supplied input, so it sits outside
// the forge SSRF-allowlist's threat model — see validate-arch.sh rule 4).
const DEFAULT_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const DEFAULT_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEFAULT_USER_URL = 'https://api.github.com/user';

// D6/C5: minimum scope for login identity + the org visibility personalized
// views need later (FR-WEB-7). Forge ingestion permissions (repo read) are a
// separate, admin-configured App/PAT connection (FR-AUTH-5) — not this scope.
const OAUTH_SCOPE = 'read:user read:org';

export interface GithubOAuthEndpoints {
  authorizeUrl?: string;
  tokenUrl?: string;
  userUrl?: string;
}

export interface GithubIdentity {
  forgeUserId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export function buildAuthorizeUrl(
  config: GithubOAuthConfig,
  state: string,
  endpoints: GithubOAuthEndpoints = {},
): string {
  const url = new URL(endpoints.authorizeUrl ?? DEFAULT_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

export class GithubOAuthError extends Error {}

export async function exchangeCodeForToken(
  config: GithubOAuthConfig,
  code: string,
  endpoints: GithubOAuthEndpoints = {},
): Promise<string> {
  const res = await fetch(endpoints.tokenUrl ?? DEFAULT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new GithubOAuthError(`token exchange failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!body.access_token) {
    throw new GithubOAuthError(
      `token exchange failed: ${body.error ?? 'unknown'} — ${body.error_description ?? ''}`,
    );
  }
  return body.access_token;
}

export async function fetchGithubIdentity(
  accessToken: string,
  endpoints: GithubOAuthEndpoints = {},
): Promise<GithubIdentity> {
  const res = await fetch(endpoints.userUrl ?? DEFAULT_USER_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      // GitHub's REST API rejects requests without a User-Agent.
      'user-agent': 'repopulse',
    },
  });
  if (!res.ok) {
    throw new GithubOAuthError(`identity fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string | null;
  };
  return {
    forgeUserId: String(body.id),
    login: body.login,
    name: body.name ?? null,
    avatarUrl: body.avatar_url ?? null,
  };
}
