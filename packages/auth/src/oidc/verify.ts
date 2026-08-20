import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { OidcError } from './errors.js';

// ID-token verification is the ONE part of this flow we do not write (D14).
// `alg` confusion and key-rotation bugs are a documented source of critical
// auth vulnerabilities, and a licence inconvenience would never justify
// hand-rolling JWKS handling. Everything around it — what we accept, which
// claims we trust, what we do with them — is still ours.

/**
 * Signature algorithms we accept, as an ALLOWLIST rather than "whatever the
 * header says". This is the single line that makes `alg: none` and the
 * RS256→HS256 confusion attack impossible: a token whose header names anything
 * else is rejected before a key is even resolved. Symmetric algorithms are
 * absent on purpose — with HS256 the verification key is the client secret,
 * and anyone holding it could mint tokens rather than merely present them.
 */
export const ALLOWED_ID_TOKEN_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

/** A key, or a key-resolution function — the shape `jose` accepts either way. */
export type KeyResolver = Parameters<typeof jwtVerify>[1];

export interface VerifyIdTokenParams {
  idToken: string;
  /** The issuer we configured; the token must claim exactly this. */
  issuer: string;
  /** Our client_id; the token must be addressed to us. */
  audience: string;
  /** The nonce we put in the authorization request, when we sent one. */
  expectedNonce?: string | undefined;
  keys: KeyResolver;
  /**
   * Small, and small on purpose. Some clock skew between our host and the IdP
   * is normal; a generous tolerance is just a longer window in which an expired
   * token still works.
   */
  clockToleranceSeconds?: number;
  /** Narrower than the default allowlist when the IdP advertises fewer. */
  algorithms?: readonly string[];
}

export interface OidcClaims {
  /** The IdP's `sub`. This, and never the email, is the identity. */
  subject: string;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
  /** Display only. */
  login: string;
  name?: string | null | undefined;
  avatarUrl?: string | null | undefined;
  raw: JWTPayload;
}

const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

/**
 * Intersects what the provider says it signs with what we are willing to accept.
 *
 * The direction is one-way: a provider that only ever issues RS256 gets ES256
 * taken OFF the table for it, which removes a whole class of substitution, but
 * nothing a provider advertises can WIDEN our allowlist. An empty intersection
 * falls back to the full allowlist rather than locking everyone out, because
 * the likeliest cause is a provider that misstates or omits the field, and a
 * discovery document is not a good enough reason to refuse every login.
 */
export function narrowAlgorithms(advertised: readonly string[]): readonly string[] {
  if (advertised.length === 0) return ALLOWED_ID_TOKEN_ALGS;
  const intersection = ALLOWED_ID_TOKEN_ALGS.filter((alg) => advertised.includes(alg));
  return intersection.length > 0 ? intersection : ALLOWED_ID_TOKEN_ALGS;
}

export async function verifyIdToken(params: VerifyIdTokenParams): Promise<OidcClaims> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(params.idToken, params.keys, {
      issuer: params.issuer,
      audience: params.audience,
      algorithms: [...(params.algorithms ?? ALLOWED_ID_TOKEN_ALGS)],
      clockTolerance: params.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
    });
    payload = result.payload;
  } catch (cause) {
    // The provider's message is kept as `cause` for the logs and deliberately
    // not surfaced: a failed verification is a failed login, and telling the
    // caller which of the five checks failed is free reconnaissance.
    throw new OidcError('oidc_id_token_invalid', 'ID token verification failed', { cause });
  }

  // jose validates iss/aud/exp/nbf and the signature; nonce is ours because it
  // is our value, not a registered JWT claim.
  if (params.expectedNonce !== undefined) {
    const nonce = payload['nonce'];
    if (typeof nonce !== 'string' || !timingSafeEqualString(nonce, params.expectedNonce)) {
      throw new OidcError('oidc_nonce_mismatch', 'ID token nonce does not match this login');
    }
  }

  return claimsFromPayload(payload);
}

export function claimsFromPayload(payload: JWTPayload): OidcClaims {
  const subject = payload.sub;
  if (typeof subject !== 'string' || subject === '') {
    throw new OidcError('oidc_subject_missing', 'ID token has no `sub` claim');
  }

  const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
  const preferred =
    typeof payload['preferred_username'] === 'string' ? payload['preferred_username'] : undefined;
  const name = typeof payload['name'] === 'string' ? payload['name'] : null;
  const picture = typeof payload['picture'] === 'string' ? payload['picture'] : null;

  return {
    subject,
    ...(email !== undefined ? { email } : {}),
    ...(typeof payload['email_verified'] === 'boolean'
      ? { emailVerified: payload['email_verified'] }
      : {}),
    // A display handle, falling back through what an IdP is most likely to
    // send. `sub` is the last resort because a UUID in the corner of the screen
    // is ugly but correct, whereas a blank name looks like a broken account.
    login: preferred ?? email ?? subject,
    name,
    avatarUrl: picture,
    raw: payload,
  };
}

// Constant-time over equal-length strings; length is not secret here (nonces
// are a fixed size) but the comparison should not leak a prefix match.
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ONE remote key set per jwks_uri, for the life of the process.
//
// `createRemoteJWKSet` is itself the cache, and it already resolves the tension
// the ticket names: it serves keys from memory, refetches when a token arrives
// with an unknown `kid` (so a rotation heals on the first token signed by the
// new key), and rate-limits that refetch with a cooldown so an attacker cannot
// turn a stream of junk `kid`s into a denial of service against the customer's
// own IdP. Constructing a new one per login would throw all of that away and
// fetch the JWKS on every single sign-in.
const remoteKeySets = new Map<string, KeyResolver>();

export function remoteKeySetFor(jwksUri: string): KeyResolver {
  const existing = remoteKeySets.get(jwksUri);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(jwksUri), {
    // Ten seconds: an IdP that cannot answer for its own keys in that time is
    // down, and a login should fail fast rather than hold a request open.
    timeoutDuration: 10_000,
    cooldownDuration: 30_000,
    // Ten minutes. Long enough that normal traffic never refetches, short
    // enough that a key REMOVED from the JWKS (the revocation case, which an
    // unknown-kid refetch does not cover) stops being trusted the same morning.
    cacheMaxAge: 10 * 60 * 1000,
  }) as KeyResolver;
  remoteKeySets.set(jwksUri, created);
  return created;
}
