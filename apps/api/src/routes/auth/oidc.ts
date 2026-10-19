import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, type Database } from '@repopulse/shared';
import { findOrCreateUserForSubject } from '@repopulse/auth';
import { admission, oidc } from '@repopulse/auth';
import { redirectToSignIn } from './problem.js';
import { AUTH_FLOW_RATE_LIMIT } from '../../plugins/rate-limits.js';
import { postLoginUrl, safeReturnTo } from './return-to.js';

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
  /** Who may join through OIDC (W20-10, UX_TODO INS-50). Unset = anyone the IdP accepts. */
  admission?: admission.AdmissionPolicy | undefined;
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
  /** The deep link the sign-in started from (W20-10, UX_TODO X-01), already vetted. */
  returnTo?: string;
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
    const { state, nonce, verifier, returnTo } = parsed as Record<string, unknown>;
    if (typeof state !== 'string' || typeof nonce !== 'string' || typeof verifier !== 'string') {
      return null;
    }
    // Re-checked on the way out as well as on the way in: the cookie is signed,
    // but the rule is cheap and the redirect is the dangerous end.
    const safe = safeReturnTo(returnTo);
    return { state, nonce, verifier, ...(safe ? { returnTo: safe } : {}) };
  } catch {
    return null;
  }
}

async function oidcRoutes(app: FastifyInstance, opts: OidcRoutesOptions): Promise<void> {
  const { config } = opts;

  app.get<{ Querystring: { return_to?: string } }>(
    '/auth/oidc/login',
    { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } },
    async (request, reply) => {
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
        // A full-page navigation from the sign-in screen: send it back there with
        // the reason rather than strand it on JSON (W20-04, UX_TODO INS-14).
        return redirectToSignIn(request, reply, opts.loginRedirectUrl, 'oidc_discovery_failed');
      }

      const tx: LoginTransaction = {
        state: oidc.generateState(),
        nonce: oidc.generateNonce(),
        verifier: oidc.createPkcePair().verifier,
      };
      const returnTo = safeReturnTo(request.query.return_to);
      if (returnTo) tx.returnTo = returnTo;
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
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    CALLBACK_PATH,
    { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } },
    async (request, reply) => {
      // Audited with the precise reason; the BROWSER goes back to the sign-in
      // screen with a code it can explain (W20-04, UX_TODO INS-14). It used to
      // end on a raw problem+json page with no way back. `title` stays as the
      // log message, which is where an operator reads it.
      const fail = (reason: string, title: string, code: string = reason): FastifyReply => {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason,
          ...auditContext(request),
        });
        request.log.info({ reason }, title);
        return redirectToSignIn(request, reply, opts.loginRedirectUrl, code);
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
        return fail('oidc_provider_error', 'Sign-in was refused by the identity provider');
      }
      if (!code || !state) return fail('missing_code_or_state', 'Missing code or state');
      if (!cookieValue) return fail('missing_state_cookie', 'Missing OIDC login cookie');

      const unsigned = request.unsignCookie(cookieValue);
      if (!unsigned.valid || unsigned.value === null) {
        return fail('state_mismatch', 'OIDC login cookie is not valid');
      }
      const tx = decodeTx(unsigned.value);
      if (!tx || tx.state !== state) {
        return fail('state_mismatch', 'OIDC state mismatch');
      }

      let metadata: oidc.OidcProviderMetadata;
      try {
        metadata = await oidc.discover(config.issuer);
      } catch (err) {
        request.log.error({ err }, 'OIDC discovery failed');
        return fail('oidc_discovery_failed', 'Identity provider discovery failed');
      }

      let tokens: oidc.TokenResponse;
      try {
        tokens = await oidc.exchangeCodeForTokens(config, metadata, code, tx.verifier);
      } catch (err) {
        request.log.warn({ err }, 'OIDC token exchange failed');
        return fail('oidc_exchange_failed', 'Identity provider token exchange failed');
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
        // The provider answered, and what it said did not authenticate anyone.
        // The specific check that failed is audited; the browser gets one code.
        return fail(reason, 'ID token verification failed', 'oidc_id_token_invalid');
      }

      // The subject is the IdP's `sub` and never the email (acceptance 3):
      // email addresses are reassigned when people leave, so keying on one
      // would hand a departed colleague's account to the next person given
      // their address. forgeUserId is left undefined on purpose — an OIDC
      // login says nothing about who commits under which forge account, and
      // guessing from a matching email would attribute someone's commits to
      // whoever registered that address (see identity-provider/index.ts).
      // W20-10 (UX_TODO INS-50): an IdP often accepts the whole company (or
      // anyone at all, with self-service signup). With a group or domain
      // allowlist set, someone outside it is refused before a user row exists.
      if (opts.admission) {
        const admitted = admission.admitOidc(opts.admission, {
          email: claims.email,
          emailVerified: claims.emailVerified,
          groups: claims.raw['groups'],
        });
        if (!admitted.ok)
          return fail(admitted.reason, 'Not on the sign-in allowlist', 'not_allowed');
      }

      const user = await findOrCreateUserForSubject(opts.db, {
        provider: 'oidc',
        subject: claims.subject,
        login: claims.login,
        ...(claims.email !== undefined ? { email: claims.email } : {}),
        name: claims.name ?? null,
        avatarUrl: claims.avatarUrl ?? null,
      });

      // New session id on sign-in, as local login does: a cookie the browser
      // arrived with (possibly one an attacker planted) must not become the
      // authenticated session. The OAuth state rides in its own cookies, so
      // nothing in the old session is needed past this point.
      await request.session.regenerate();
      request.session.set('userId', user.id);
      request.session.set('createdAt', Date.now());
      await request.session.save();

      auditLog(request.log, {
        event: 'auth.login.success',
        actorUserId: user.id,
        provider: 'oidc',
        ...auditContext(request),
      });

      return reply.redirect(postLoginUrl(opts.loginRedirectUrl, tx.returnTo ?? null));
    },
  );
}

export default fp(oidcRoutes, { name: '@repopulse/api-oidc-routes' });
