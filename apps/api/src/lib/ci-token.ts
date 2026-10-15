import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';

type CiTokenScope = core.CiTokenScope;

// Customer-CI read tokens (W18-18, D16 "CI pull").
//
// The customer's CI calls RepoPulse with one of these and gets back the
// findings a PR introduced. Everything about the credential is shaped by that
// being ALL it can do: one read scope, a fixed repository list, and a guard in
// the /api/v1 plugin that refuses every route not explicitly marked as
// accepting it (see FastifyContextConfig.ciToken below).

/** Recognisable by shape, so the SC-2 log scrubber and secret scanners can find a leaked one. */
export const CI_TOKEN_PREFIX = 'rpci_';
/** 32 random bytes → 43 base64url characters. */
const CI_TOKEN_RANDOM_BYTES = 32;
const CI_TOKEN_PATTERN = /^rpci_[A-Za-z0-9_-]{43}$/;
/** Characters of the token kept for display: the prefix plus eight random ones. */
const DISPLAY_PREFIX_LENGTH = CI_TOKEN_PREFIX.length + 8;

export interface MintedCiToken {
  /** The secret. Returned to the creator once and never again. */
  token: string;
  hash: string;
  displayPrefix: string;
}

export function hashCiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function mintCiToken(): MintedCiToken {
  const token = CI_TOKEN_PREFIX + randomBytes(CI_TOKEN_RANDOM_BYTES).toString('base64url');
  return { token, hash: hashCiToken(token), displayPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/**
 * The bearer credential on a request, or null when there is no Authorization
 * header at all.
 *
 * Returns `''` for a header that is present but malformed: a request that TRIED
 * to authenticate with a token must be judged as a token request and refused,
 * never quietly downgraded to "no token, try the session cookie instead".
 */
export function bearerFrom(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1] ?? '';
}

export interface ResolvedCiToken {
  id: number;
  workspaceId: number;
  scope: CiTokenScope;
  repoIds: number[];
}

/**
 * Looks the token up by hash. Null for anything that should be a 401: an
 * unknown, malformed, revoked or expired token are all the same answer, so a
 * caller cannot use the difference to learn which tokens once existed.
 */
export async function resolveCiToken(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<ResolvedCiToken | null> {
  if (!CI_TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select({
      id: core.ciTokens.id,
      workspaceId: core.ciTokens.workspaceId,
      scope: core.ciTokens.scope,
      repoIds: core.ciTokens.repoIds,
    })
    .from(core.ciTokens)
    .where(
      and(
        eq(core.ciTokens.tokenHash, hashCiToken(token)),
        isNull(core.ciTokens.revokedAt),
        or(isNull(core.ciTokens.expiresAt), gt(core.ciTokens.expiresAt, now)),
      ),
    )
    .limit(1);
  if (!row) return null;
  // Best-effort: a failed stamp must not fail the CI build that is reading.
  await db
    .update(core.ciTokens)
    .set({ lastUsedAt: now })
    .where(eq(core.ciTokens.id, row.id))
    .catch(() => undefined);
  return { ...row, scope: row.scope as CiTokenScope };
}

/**
 * Route config marking a route as callable with a CI token, and with which
 * scope. A route WITHOUT this is unreachable by a token whatever its method —
 * the allowlist is opt-in per route, so a route added next year is closed to
 * CI tokens until someone decides otherwise.
 */
declare module 'fastify' {
  interface FastifyContextConfig {
    ciToken?: { scope: CiTokenScope };
  }
  interface FastifyRequest {
    /** Set only when the request authenticated with a CI token instead of a session. */
    ciToken?: ResolvedCiToken;
  }
}
