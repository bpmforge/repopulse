import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditLog, type Database } from '@repopulse/shared';
import { findOrCreateUserForSubject } from '@repopulse/auth';
import { oidc } from '@repopulse/auth';
import { sendProblem } from './problem.js';
import { AUTH_FLOW_RATE_LIMIT } from '../../plugins/rate-limits.js';

// Generic OIDC login (W15-03, D14).
//
// PRECONDITIONS this plugin does NOT satisfy itself:
//  - `request.session` must already exist. routes/auth/index.ts registers the
//    session plugin through fastify-plugin, so it decorates the enclosing
//    scope; registering a second copy here would collide on @fastify/cookie's
//    decorators. Register this plugin in the same scope, after that one.
//  - It must only be registered when `oidcConfigFromEnv` returned a config.
//    A deployment that has not configured OIDC does not get the routes at all,
//    which is a cleaner "not offered" than a 404 handler that exists (D14,
//    acceptance 5).
//
// Everything except ID-token verification is ours, on purpose: discovery, the
// authorization redirect, PKCE and the code exchange are plain HTTPS of the
// same shape as the GitHub OAuth routes next door. Only the cryptography is
// borrowed, from `jose`.

export interface OidcRoutesOptions {
  db: Database;
  config: oidc.OidcConfig;
  /** Where to send the browser once a session exists (the SPA). */
  loginRedirectUrl: string;
  /** false over http://localhost, or the browser drops the cookie silently. */
  cookieSecure: boolean;
  /**
   * Test-only override for the key resolver, so a suite can hand in a local
   * JWKS instead of reaching the provider's `jwks_uri` over a socket.
   */
  keyResolver?: oidc.KeyResolver;
}

// One cookie carries the whole per-login transaction. Three cookies would be
// three things that can arrive out of step; one either verifies as a unit or
// does not.
const TX_COOKIE = 'oidc_tx';
const CALLBACK_PATH = '/auth/oidc/callback';
// Ten minutes is a login, not a session. Longer only widens the window in which
// a stolen transaction cookie is still worth something.
const TX_MAX_AGE_SECONDS = 600;

interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
}

function auditContext(request: FastifyRequest) {
  return { ip: request.ip, ua: request.headers['user-agent'] ?? null, workspaceId: null };
}

function encodeTx(tx: LoginTransaction): string {
  return Buffer.from(JSON.stringify(tx), 'utf8').toString('base64url');
}

function decodeTx(value: string): LoginTransaction | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { state, nonce, verifier } = parsed as Record<string, unknown>;
    if (typeof state !== 'string' || typeof nonce !== 'string' || typeof verifier !== 'string') {
      return null;
    }
    return { state, nonce, verifier };
  } catch {
    return null;
  }
}

async function oidcRoutes(app: FastifyInstance, opts: OidcRoutesOptions): Promise<void> {
  const { config } = opts;

  app.get('/auth/oidc/login', { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } }, async (request, reply) => {
    let metadata: oidc.OidcProviderMetadata;
    try {
      metadata = await oidc.discover(config.issuer);
    } catch (err) {
      request.log.error({ err }, 'OIDC discovery failed');
      auditLog(request.log, {
        event: 'auth.login.failure',
        actorUserId: null,
        reason: 'oidc_discovery_failed',
        ...auditContext(request),
      });
      return sendProblem(request, reply, 502, 'Identity provider discovery failed');
    }

    const tx: LoginTransaction = {
      state: oidc.generateState(),
      nonce: oidc.generateNonce(),
      verifier: oidc.createPkcePair().verifier,
    };
    // The cookie is SIGNED, so a callback cannot arrive carrying a state the
    // attacker chose — that is the classic OIDC CSRF, and it is why state has
    // to be compared against something the browser could not have forged.
    reply.setCookie(TX_COOKIE, encodeTx(tx), {
      signed: true,
      httpOnly: true,
      secure: opts.cookieSecure,
      sameSite: 'lax',
      path: CALLBACK_PATH,
      maxAge: TX_MAX_AGE_SECONDS,
    });

    return reply.redirect(
      oidc.buildAuthorizationUrl(config, metadata, {
        state: tx.state,
        nonce: tx.nonce,
        codeChallenge: oidc.deriveChallenge(tx.verifier),
      }),
    );
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    CALLBACK_PATH,
    { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } },
    async (request, reply) => {
      const fail = (
        status: number,
        reason: string,
        title: string,
      ): void => {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason,
          ...auditContext(request),
        });
        return sendProblem(request, reply, status, title);
      };

      const cookieValue = request.cookies[TX_COOKIE];
      // Cleared unconditionally: whether this callback succeeds or fails, that
      // transaction is spent and must not be usable for a second attempt.
      reply.clearCookie(TX_COOKIE, { path: CALLBACK_PATH });

      const { code, state, error } = request.query;
      if (error) {
        // The provider refused (consent denied, account disabled). Its message
        // is not echoed back — it is attacker-influenceable text.
        request.log.info({ oidcError: error }, 'OIDC provider returned an error');
        return fail(400, 'oidc_provider_error', 'Sign-in was refused by the identity provider');
      }
      if (!code || !state) return fail(400, 'missing_code_or_state', 'Missing code or state');
      if (!cookieValue) return fail(400, 'missing_state_cookie', 'Missing OIDC login cookie');

      const unsigned = request.unsignCookie(cookieValue);
      if (!unsigned.valid || unsigned.value === null) {
        return fail(400, 'state_mismatch', 'OIDC login cookie is not valid');
      }
      const tx = decodeTx(unsigned.value);
      if (!tx || tx.state !== state) {
        return fail(400, 'state_mismatch', 'OIDC state mismatch');
      }

      let metadata: oidc.OidcProviderMetadata;
      try {
        metadata = await oidc.discover(config.issuer);
      } catch (err) {
        request.log.error({ err }, 'OIDC discovery failed');
        return fail(502, 'oidc_discovery_failed', 'Identity provider discovery failed');
      }

      let tokens: oidc.TokenResponse;
      try {
        tokens = await oidc.exchangeCodeForTokens(config, metadata, code, tx.verifier);
      } catch (err) {
        request.log.warn({ err }, 'OIDC token exchange failed');
        return fail(502, 'oidc_exchange_failed', 'Identity provider token exchange failed');
      }

      let claims: oidc.OidcClaims;
      try {
        claims = await oidc.verifyIdToken({
          idToken: tokens.idToken,
          issuer: config.issuer,
          audience: config.clientId,
          expectedNonce: tx.nonce,
          // Narrowed by what this provider advertises it signs with; never
          // widened by it.
          algorithms: oidc.narrowAlgorithms(metadata.idTokenSigningAlgs),
          keys: opts.keyResolver ?? oidc.remoteKeySetFor(metadata.jwksUri),
        });
      } catch (err) {
        request.log.warn({ err }, 'OIDC ID token verification failed');
        const reason = err instanceof oidc.OidcError ? err.code : 'oidc_id_token_invalid';
        // 401, not 502: the provider answered, and what it said did not
        // authenticate anyone.
        return fail(401, reason, 'ID token verification failed');
      }

      // The subject is the IdP's `sub` and never the email (acceptance 3):
      // email addresses are reassigned when people leave, so keying on one
      // would hand a departed colleague's account to the next person given
      // their address. forgeUserId is left undefined on purpose — an OIDC
      // login says nothing about who commits under which forge account, and
      // guessing from a matching email would attribute someone's commits to
      // whoever registered that address (see identity-provider/index.ts).
      const user = await findOrCreateUserForSubject(opts.db, {
        provider: 'oidc',
        subject: claims.subject,
        login: claims.login,
        ...(claims.email !== undefined ? { email: claims.email } : {}),
        name: claims.name ?? null,
        avatarUrl: claims.avatarUrl ?? null,
      });

      request.session.set('userId', user.id);
      request.session.set('createdAt', Date.now());
      await request.session.save();

      auditLog(request.log, {
        event: 'auth.login.success',
        actorUserId: user.id,
        provider: 'oidc',
        ...auditContext(request),
      });

      return reply.redirect(opts.loginRedirectUrl);
    },
  );
}

export default fp(oidcRoutes, { name: '@repopulse/api-oidc-routes' });
