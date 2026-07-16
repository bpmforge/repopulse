import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditLog, type Database } from '@repopulse/shared';
import { oauth, session as sessionModule } from '@repopulse/auth';
import { sendProblem } from './problem.js';
import { AUTH_FLOW_RATE_LIMIT } from '../../plugins/rate-limits.js';

export interface AuthRoutesOptions extends sessionModule.SessionPluginOptions {
  db: Database;
  githubOAuth: oauth.GithubOAuthConfig;
  /** Test-only override to point at a mocked GitHub instead of the real one. */
  githubEndpoints?: oauth.GithubOAuthEndpoints;
  /** Where to send the browser after a successful login (the SPA). */
  loginRedirectUrl: string;
}

const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_MAX_AGE_SECONDS = 600;

// SC-22: audit context is the same shape for every event this module emits.
// workspaceId is always null here - workspace resolution happens later, in
// apiV1's preHandler (W1-04), not in these auth routes.
function auditContext(request: FastifyRequest) {
  return { ip: request.ip, ua: request.headers['user-agent'] ?? null, workspaceId: null };
}

async function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  await app.register(sessionModule.sessionPlugin, {
    redisUrl: opts.redisUrl,
    sessionSecret: opts.sessionSecret,
    idleTimeoutMs: opts.idleTimeoutMs,
    absoluteLifetimeMs: opts.absoluteLifetimeMs,
    cookieSecure: opts.cookieSecure,
  });

  app.get(
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
      const authorizeUrl = oauth.buildAuthorizeUrl(opts.githubOAuth, state, opts.githubEndpoints);
      return reply.redirect(authorizeUrl);
    },
  );

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
        return sendProblem(request, reply, 400, 'Missing code or state', undefined);
      }

      const cookieValue = request.cookies[OAUTH_STATE_COOKIE];
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/callback' });
      if (!cookieValue) {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'missing_state_cookie',
          ...auditContext(request),
        });
        return sendProblem(request, reply, 400, 'Missing OAuth state cookie');
      }
      const unsigned = request.unsignCookie(cookieValue);
      if (!unsigned.valid || unsigned.value !== state) {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'state_mismatch',
          ...auditContext(request),
        });
        return sendProblem(request, reply, 400, 'OAuth state mismatch');
      }

      let accessToken: string;
      try {
        accessToken = await oauth.exchangeCodeForToken(
          opts.githubOAuth,
          code,
          opts.githubEndpoints,
        );
      } catch (err) {
        request.log.warn({ err }, 'GitHub OAuth token exchange failed');
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'oauth_exchange_failed',
          ...auditContext(request),
        });
        return sendProblem(request, reply, 502, 'GitHub OAuth token exchange failed');
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
        return sendProblem(request, reply, 502, 'GitHub identity fetch failed');
      }

      const user = await oauth.findOrCreateUser(opts.db, identity);

      request.session.set('userId', user.id);
      request.session.set('createdAt', Date.now());
      await request.session.save();

      auditLog(request.log, {
        event: 'auth.login.success',
        actorUserId: user.id,
        ...auditContext(request),
      });

      return reply.redirect(opts.loginRedirectUrl);
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
