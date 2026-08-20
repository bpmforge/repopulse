import { OidcError } from './errors.js';

// Discovery is ours (D14): it is one HTTPS GET and a shape check, and the only
// thing we borrow from `jose` is the cryptography.

export interface OidcProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /**
   * From `id_token_signing_alg_values_supported`. Narrowing only: `narrowAlgorithms`
   * intersects it with our allowlist, so a provider can tell us to accept LESS
   * but never more.
   */
  idTokenSigningAlgs: string[];
  /** From `token_endpoint_auth_methods_supported`; empty when the IdP omits it. */
  tokenEndpointAuthMethods: string[];
}

export interface DiscoveryOptions {
  /** Injected so tests can serve a fixture document without a socket. */
  fetchImpl?: typeof fetch;
  /** Skip the process-wide cache; used by tests and by an explicit refresh. */
  cache?: Map<string, CacheEntry>;
  now?: () => number;
  ttlMs?: number;
}

export interface CacheEntry {
  metadata: OidcProviderMetadata;
  expiresAt: number;
}

// An hour. The discovery document changes when an operator reconfigures their
// IdP, which is a thing that happens on the scale of days; refetching it per
// login would be a self-inflicted request amplifier on the customer's own SSO.
const DEFAULT_TTL_MS = 60 * 60 * 1000;

const processCache = new Map<string, CacheEntry>();

export function discoveryUrl(issuer: string): string {
  // Issuer identifiers are compared exactly, but operators type trailing
  // slashes. Stripping it here avoids building `https://id.example.com//.well-known`,
  // which some providers 404 and others redirect.
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

export async function discover(
  issuer: string,
  options: DiscoveryOptions = {},
): Promise<OidcProviderMetadata> {
  const cache = options.cache ?? processCache;
  const now = options.now ?? Date.now;
  const cached = cache.get(issuer);
  if (cached && cached.expiresAt > now()) return cached.metadata;

  const url = discoveryUrl(issuer);
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers: { accept: 'application/json' } });
  } catch (cause) {
    throw new OidcError('oidc_discovery_failed', `OIDC discovery request to ${url} failed`, {
      cause,
    });
  }
  if (!res.ok) {
    throw new OidcError('oidc_discovery_failed', `OIDC discovery ${url} returned HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (cause) {
    throw new OidcError('oidc_discovery_invalid', `OIDC discovery ${url} returned invalid JSON`, {
      cause,
    });
  }

  const metadata = parseMetadata(issuer, body);
  cache.set(issuer, { metadata, expiresAt: now() + (options.ttlMs ?? DEFAULT_TTL_MS) });
  return metadata;
}

function stringField(doc: Record<string, unknown>, name: string): string | undefined {
  const value = doc[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function stringArray(doc: Record<string, unknown>, name: string): string[] {
  const value = doc[name];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Turns a discovery document into the four things we actually need.
 *
 * Missing endpoints fail HERE, at parse time, with a named error that says
 * which field was absent — not later as a `undefined is not a URL` at the
 * moment a user clicks Sign in. `userinfo_endpoint` is deliberately NOT
 * required: every claim we consume comes from the ID token, so a provider that
 * omits userinfo is perfectly usable by us and refusing it would be us
 * enforcing a part of the spec we do not use.
 */
export function parseMetadata(expectedIssuer: string, body: unknown): OidcProviderMetadata {
  if (typeof body !== 'object' || body === null) {
    throw new OidcError('oidc_discovery_invalid', 'OIDC discovery document is not an object');
  }
  const doc = body as Record<string, unknown>;

  const issuer = stringField(doc, 'issuer');
  if (issuer === undefined) {
    throw new OidcError('oidc_discovery_invalid', 'OIDC discovery document has no `issuer`');
  }
  // OpenID Connect Discovery §4.3 requires this comparison, and it is not a
  // formality: without it, anyone who can answer for the URL we fetched can
  // hand us a document naming a jwks_uri they control, and every later
  // signature check would then pass against the attacker's keys.
  if (issuer !== expectedIssuer.replace(/\/+$/, '') && issuer !== expectedIssuer) {
    throw new OidcError(
      'oidc_discovery_invalid',
      `OIDC discovery issuer mismatch: document says ${issuer}, configured ${expectedIssuer}`,
    );
  }

  const required = {
    authorizationEndpoint: stringField(doc, 'authorization_endpoint'),
    tokenEndpoint: stringField(doc, 'token_endpoint'),
    jwksUri: stringField(doc, 'jwks_uri'),
  };
  for (const [field, value] of Object.entries(required)) {
    if (value === undefined) {
      throw new OidcError(
        'oidc_discovery_invalid',
        `OIDC discovery document from ${issuer} is missing ${snakeOf(field)}, which the authorization-code flow cannot work without`,
      );
    }
  }

  return {
    issuer,
    authorizationEndpoint: required.authorizationEndpoint as string,
    tokenEndpoint: required.tokenEndpoint as string,
    jwksUri: required.jwksUri as string,
    idTokenSigningAlgs: stringArray(doc, 'id_token_signing_alg_values_supported'),
    tokenEndpointAuthMethods: stringArray(doc, 'token_endpoint_auth_methods_supported'),
  };
}

function snakeOf(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
