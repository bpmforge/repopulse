import { createSign } from 'node:crypto';

// Vertex AI authentication (W19-01).
//
// Vertex does not take an API key. The credential is a Google SERVICE ACCOUNT
// JSON; it signs a short-lived JWT, Google's token endpoint exchanges that for
// an OAuth access token, and the access token is what goes in the bearer
// header. The whole flow is RS256 over node:crypto — no dependency — and the
// service-account JSON is the thing stored encrypted in the credentials vault,
// exactly like any other provider key. Only the access token (about an hour)
// ever reaches the wire to the model endpoint; it is cached in memory and never
// persisted or logged.
//
// Verified against Google's documented OAuth 2.0 service-account flow
// (https://developers.google.com/identity/protocols/oauth2/service-account):
// JWT claims iss/scope/aud/iat/exp, grant_type
// urn:ietf:params:oauth:grant-type:jwt-bearer, POST to the token_uri.

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/** Refresh this long before Google's stated expiry so a call never races it. */
const SKEW_MS = 60_000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

export class ServiceAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceAccountError';
  }
}

/** Parses and checks the pasted JSON, with a sentence for each way it can be wrong. */
export function parseServiceAccount(raw: string): ServiceAccount {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new ServiceAccountError(
      'the credential is not JSON — paste the whole service-account key file, not a token',
    );
  }
  const o = (doc ?? {}) as Record<string, unknown>;
  if (o.type !== undefined && o.type !== 'service_account') {
    throw new ServiceAccountError(
      `the credential is a Google "${String(o.type)}" key; Vertex needs a service_account key`,
    );
  }
  for (const field of ['client_email', 'private_key'] as const) {
    if (typeof o[field] !== 'string' || o[field] === '') {
      throw new ServiceAccountError(`the service-account key has no "${field}"`);
    }
  }
  const tokenUri =
    typeof o.token_uri === 'string' ? o.token_uri : 'https://oauth2.googleapis.com/token';
  // A key file is data a person pasted; refuse a token endpoint that is not
  // Google's, or the signed assertion would be posted wherever the file says.
  if (!/^https:\/\/([a-z0-9-]+\.)?googleapis\.com\//.test(tokenUri)) {
    throw new ServiceAccountError(
      "the service-account key names a token endpoint that is not Google's",
    );
  }
  return {
    client_email: o.client_email as string,
    private_key: o.private_key as string,
    token_uri: tokenUri,
    ...(typeof o.project_id === 'string' ? { project_id: o.project_id } : {}),
  };
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function signAssertion(sa: ServiceAccount, nowSec: number): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${claims}`);
  let sig: Buffer;
  try {
    sig = signer.sign(sa.private_key);
  } catch {
    throw new ServiceAccountError(
      'the service-account private key could not be read as an RSA key',
    );
  }
  return `${head}.${claims}.${b64u(sig)}`;
}

const cache = new Map<string, { token: string; expiresAt: number }>();

export interface TokenDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Exchanges the service account for an access token, cached until near expiry. */
export async function mintAccessToken(raw: string, deps: TokenDeps = {}): Promise<string> {
  const now = deps.now ?? Date.now;
  const sa = parseServiceAccount(raw);
  const key = sa.client_email;
  const hit = cache.get(key);
  if (hit && hit.expiresAt - SKEW_MS > now()) return hit.token;

  const f = deps.fetchImpl ?? fetch;
  const res = await f(sa.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: GRANT,
      assertion: signAssertion(sa, Math.floor(now() / 1000)),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Google's error JSON names the cause (invalid_grant, invalid_scope) and
    // never echoes the assertion, so it is safe to surface.
    let detail = '';
    try {
      const j = (await res.json()) as { error?: string; error_description?: string };
      detail = [j.error, j.error_description].filter(Boolean).join(': ');
    } catch {
      /* body was not JSON */
    }
    throw new ServiceAccountError(
      `Google rejected the service account (${res.status}${detail ? ` — ${detail}` : ''})`,
    );
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new ServiceAccountError('Google returned no access token');
  cache.set(key, {
    token: body.access_token,
    expiresAt: now() + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}

export function clearTokenCache(): void {
  cache.clear();
}
