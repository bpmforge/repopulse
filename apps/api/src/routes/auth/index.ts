import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditLog, type Database } from '@repopulse/shared';
import { admission, oauth, session as sessionModule } from '@repopulse/auth';
import { redirectToSignIn, sendProblem } from './problem.js';
import { AUTH_FLOW_RATE_LIMIT } from '../../plugins/rate-limits.js';
import { postLoginUrl, RETURN_TO_COOKIE, safeReturnTo } from './return-to.js';

export interface AuthRoutesOptions extends sessionModule.SessionPluginOptions {
  db: Database;
  /**
   * Absent on a deployment that does not offer forge sign-in (W15-02, D14).
   *
   * This plugin still registers — it owns the session that local and OIDC both
   * use — but /auth/login and /auth/callback simply do not exist. A dead button
   * that redirects to a vendor nobody configured is worse than no button.
   */
  githubOAuth?: oauth.GithubOAuthConfig | undefined;
  /** Test-only override to point at a mocked GitHub instead of the real one. */
  githubEndpoints?: oauth.GithubOAuthEndpoints;
  /** Where to send the browser after a successful login (the SPA). */
  loginRedirectUrl: string;
  /** Who may join through GitHub sign-in (W20-10, UX_TODO INS-50). Unset = anyone. */
  admission?: admission.AdmissionPolicy | undefined;
}

const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_MAX_AGE_SECONDS = 600;

// SC-22: audit context is the same shape for every event this module emits.
// workspaceId is always null here - workspace resolution happens later, in
// apiV1's preHandler (W1-04), not in these auth routes.
function auditContext(request: FastifyRequest) {
  return { ip: request.ip, ua: request.headers['user-agent'] ?? null, workspaceId: null };
}

/** The vetted return path from the signed cookie, re-checked; null when absent or tampered. */
function signedReturnTo(request: FastifyRequest): string | null {
  const raw = request.cookies[RETURN_TO_COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? safeReturnTo(unsigned.value) : null;
}

async function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  await app.register(sessionModule.sessionPlugin, {
    redisUrl: opts.redisUrl,
    sessionSecret: opts.sessionSecret,
    idleTimeoutMs: opts.idleTimeoutMs,
    absoluteLifetimeMs: opts.absoluteLifetimeMs,
    cookieSecure: opts.cookieSecure,
  });

  if (!opts.githubOAuth) return;
  const githubOAuth = opts.githubOAuth;

  app.get<{ Querystring: { return_to?: string } }>(
    '/auth/login',
    { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } },
    async (request, reply) => {
      const state = oauth.generateState();
      reply.setCookie(OAUTH_STATE_COOKIE, state, {
        signed: true,
        httpOnly: true,
        secure: opts.cookieSecure,
        sameSite: 'lax',
        path: '/auth/callback',
        maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
      });
      // W20-10 (UX_TODO X-01): the deep link the sign-in started from. Signed,
      // so the callback only ever follows a path this route already vetted.
      const returnTo = safeReturnTo(request.query.return_to);
      if (returnTo) {
        reply.setCookie(RETURN_TO_COOKIE, returnTo, {
          signed: true,
          httpOnly: true,
          secure: opts.cookieSecure,
          sameSite: 'lax',
          path: '/auth/callback',
          maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
        });
      } else {
        reply.clearCookie(RETURN_TO_COOKIE, { path: '/auth/callback' });
      }
      const authorizeUrl = oauth.buildAuthorizeUrl(githubOAuth, state, opts.githubEndpoints);
      return reply.redirect(authorizeUrl);
    },
  );

  // Every failure below ends on the sign-in screen, not a JSON body (W20-04,
  // UX_TODO INS-14): this is a browser navigation, and the audit line keeps
  // the precise reason for the operator.
  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/callback',
    { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } },
    async (request, reply) => {
      const { code, state } = request.query;
      if (!code || !state) {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'missing_code_or_state',
          ...auditContext(request),
        });
        return redirectToSignIn(request, reply, opts.loginRedirectUrl, 'missing_code_or_state');
      }

      const cookieValue = request.cookies[OAUTH_STATE_COOKIE];
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/callback' });
      const returnTo = signedReturnTo(request);
      reply.clearCookie(RETURN_TO_COOKIE, { path: '/auth/callback' });
      if (!cookieValue) {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'missing_state_cookie',
          ...auditContext(request),
        });
        return redirectToSignIn(request, reply, opts.loginRedirectUrl, 'missing_state_cookie');
      }
      const unsigned = request.unsignCookie(cookieValue);
      if (!unsigned.valid || unsigned.value !== state) {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'state_mismatch',
          ...auditContext(request),
        });
        return redirectToSignIn(request, reply, opts.loginRedirectUrl, 'state_mismatch');
      }

      let accessToken: string;
      try {
        accessToken = await oauth.exchangeCodeForToken(githubOAuth, code, opts.githubEndpoints);
      } catch (err) {
        request.log.warn({ err }, 'GitHub OAuth token exchange failed');
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'oauth_exchange_failed',
          ...auditContext(request),
        });
        return redirectToSignIn(request, reply, opts.loginRedirectUrl, 'oauth_exchange_failed');
      }

      let identity: oauth.GithubIdentity;
      try {
        identity = await oauth.fetchGithubIdentity(accessToken, opts.githubEndpoints);
      } catch (err) {
        request.log.warn({ err }, 'GitHub identity fetch failed');
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'identity_fetch_failed',
          ...auditContext(request),
        });
        return redirectToSignIn(request, reply, opts.loginRedirectUrl, 'identity_fetch_failed');
      }

      // W20-10 (UX_TODO INS-50): with an org allowlist set, a GitHub account
      // outside it is refused BEFORE a user row exists, so it never becomes a
      // member. Checked on every sign-in, so leaving the org ends access.
      if (opts.admission && admission.needsGithubOrgs(opts.admission)) {
        let orgs: string[];
        try {
          orgs = await oauth.fetchGithubOrgLogins(accessToken, opts.githubEndpoints);
        } catch (err) {
          request.log.warn({ err }, 'GitHub org membership fetch failed');
          auditLog(request.log, {
            event: 'auth.login.failure',
            actorUserId: null,
            reason: 'org_check_failed',
            login: identity.login,
            ...auditContext(request),
          });
          return redirectToSignIn(request, reply, opts.loginRedirectUrl, 'org_check_failed');
        }
        const admitted = admission.admitGithub(opts.admission, orgs);
        if (!admitted.ok) {
          auditLog(request.log, {
            event: 'auth.login.failure',
            actorUserId: null,
            reason: admitted.reason,
            login: identity.login,
            ...auditContext(request),
          });
          return redirectToSignIn(request, reply, opts.loginRedirectUrl, 'not_allowed');
        }
      }

      const user = await oauth.findOrCreateUser(opts.db, identity);

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
        ...auditContext(request),
      });

      return reply.redirect(postLoginUrl(opts.loginRedirectUrl, returnTo));
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const userId = request.session.get('userId');
    if (userId !== undefined) {
      await request.session.destroy();
      auditLog(request.log, {
        event: 'auth.logout',
        actorUserId: userId,
        ...auditContext(request),
      });
    }
    return reply.code(204).send();
  });

  app.get('/me', async (request, reply) => {
    const userId = request.session.get('userId');
    if (userId === undefined) {
      return sendProblem(request, reply, 401, 'No active session');
    }
    const { findUserById } = oauth;
    const user = await findUserById(opts.db, userId);
    if (!user) {
      await request.session.destroy();
      return sendProblem(request, reply, 401, 'No active session');
    }
    // Minimal shape (W1-03): {user}. workspace/role/identity_id/default_view_id
    // per docs/API_DESIGN.md §2 need workspace/RBAC infra that's W1-04's scope
    // (packages/auth/src/workspace/**) — not yet built. See plan.json HANDOFF.
    return reply.send({ user });
  });
}

export default fp(authRoutes, { name: '@repopulse/api-auth-routes' });
