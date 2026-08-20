import type { OidcConfig } from './config.js';
import type { OidcProviderMetadata } from './discovery.js';
import { OidcError } from './errors.js';

// The authorization request and the code exchange are plain HTTPS, and we
// already do exactly this shape for GitHub OAuth (packages/auth/src/oauth/
// github.ts). D14 records the split on purpose: plumbing is ours, cryptography
// is borrowed.

export interface AuthorizationRequestParams {
  state: string;
  nonce: string;
  codeChallenge: string;
}

export function buildAuthorizationUrl(
  config: OidcConfig,
  metadata: OidcProviderMetadata,
  params: AuthorizationRequestParams,
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface TokenResponse {
  idToken: string;
  accessToken?: string | undefined;
  tokenType?: string | undefined;
}

export interface ExchangeOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Picks how we authenticate to the token endpoint.
 *
 * `client_secret_basic` is what the spec says a provider MUST support and what
 * most default to, so it wins when advertised. `client_secret_post` is the
 * fallback rather than the default because a secret in a form body ends up in
 * more logs than one in an Authorization header. When the IdP advertises
 * nothing we send POST, which is the more widely tolerated of the two among
 * providers that do not document the choice.
 */
export function tokenAuthMethod(metadata: OidcProviderMetadata): 'basic' | 'post' {
  return metadata.tokenEndpointAuthMethods.includes('client_secret_basic') ? 'basic' : 'post';
}

export async function exchangeCodeForTokens(
  config: OidcConfig,
  metadata: OidcProviderMetadata,
  code: string,
  codeVerifier: string,
  options: ExchangeOptions = {},
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    // The verifier the IdP will hash and compare against the challenge we sent
    // at /authorize. This is the round trip that makes a stolen code useless.
    code_verifier: codeVerifier,
    client_id: config.clientId,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (tokenAuthMethod(metadata) === 'basic') {
    // RFC 6749 §2.3.1: form-urlencode each half BEFORE base64, or a secret
    // containing a `:` or a `+` authenticates as something else.
    const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
    headers['authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
  } else {
    body.set('client_secret', config.clientSecret);
  }

  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(metadata.tokenEndpoint, { method: 'POST', headers, body: body.toString() });
  } catch (cause) {
    throw new OidcError('oidc_exchange_failed', 'OIDC token request failed', { cause });
  }
  if (!res.ok) {
    throw new OidcError(
      'oidc_exchange_failed',
      `OIDC token endpoint returned HTTP ${res.status}`,
    );
  }

  let payload: { id_token?: unknown; access_token?: unknown; token_type?: unknown; error?: unknown };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (cause) {
    throw new OidcError('oidc_exchange_failed', 'OIDC token endpoint returned invalid JSON', {
      cause,
    });
  }
  if (typeof payload.id_token !== 'string' || payload.id_token === '') {
    throw new OidcError(
      'oidc_id_token_missing',
      'OIDC token response carried no id_token — the provider may not have the openid scope enabled for this client',
    );
  }

  return {
    idToken: payload.id_token,
    ...(typeof payload.access_token === 'string' ? { accessToken: payload.access_token } : {}),
    ...(typeof payload.token_type === 'string' ? { tokenType: payload.token_type } : {}),
  };
}
