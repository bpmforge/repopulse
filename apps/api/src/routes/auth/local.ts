import { randomBytes } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, type Database } from '@repopulse/shared';
import { findUserById, workspace as workspaceModule, local } from '@repopulse/auth';
import { core } from '@repopulse/shared';
import { and, eq } from 'drizzle-orm';
import { sendProblem } from './problem.js';
import { AUTH_FLOW_RATE_LIMIT } from '../../plugins/rate-limits.js';

// Local email + password sign-in (W15-02, D14).
//
// This is a way to AUTHENTICATE, not a second session system: it ends at the
// same `request.session` the GitHub callback writes, issued by the same session
// plugin. Which is why this module registers nothing — it is `fp`-wrapped and
// MUST be registered after ./index.ts, whose own session plugin registration
// escapes to the root context and decorates the request for both of us.
// Registering @fastify/session twice would throw on the duplicate cookie
// decorator, so this file deliberately does not.
//
// THERE IS NO SIGNUP ROUTE HERE and there must never be one. A self-hosted
// install is typically reachable on a LAN or a cloud box the day it comes up;
// an open registration form on it means the instance belongs to whoever finds
// the URL. Accounts come from the first-boot bootstrap or from an admin.

export interface LocalAuthRoutesOptions {
  db: Database;
  /**
   * Where people sign in: PUBLIC_BASE_URL + '/' (W20-19, UX_TODO INS-62). Sent
   * back with a new account so the admin's invite names the right address.
   */
  signInUrl?: string;
}

/** What a user looks like on the wire. Never the hash, never the flag's absence. */
function publicUser(user: typeof core.users.$inferSelect) {
  return {
    id: user.id,
    login: user.login,
    email: user.email,
    name: user.name,
    avatar_url: user.avatarUrl,
    must_change_password: user.mustChangePassword,
  };
}

function auditContext(request: FastifyRequest) {
  return { ip: request.ip, ua: request.headers['user-agent'] ?? null, workspaceId: null };
}

/** Sends a problem response AND hands Fastify the reply, so a handler cannot
 *  accidentally `return undefined` after the reply is already on the wire. */
function problem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  sendProblem(request, reply, status, title, detail);
  return reply;
}

/**
 * The ONE response every failed sign-in gets.
 *
 * Wrong password, unknown address, and an address that belongs to a GitHub or
 * OIDC account are the same 401 with the same title and no detail. The timing
 * is equalised in `local.verifyLocalCredentials`; this equalises what is said. Both
 * halves are required — identical prose returned in a tenth of the time is
 * still an answer to "does this person have an account here".
 */
function invalidCredentials(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return problem(request, reply, 401, 'Invalid email or password');
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

async function localAuthRoutes(app: FastifyInstance, opts: LocalAuthRoutesOptions): Promise<void> {
  app.post(
    '/auth/local/login',
    { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } },
    async (request, reply) => {
      const email = readString(request.body, 'email');
      const password = readString(request.body, 'password');
      // A missing field is a client bug, not a guess at an account, so it is
      // safe to distinguish it — it says nothing about who exists.
      if (email === undefined || password === undefined) {
        return problem(request, reply, 400, 'email and password are required');
      }

      const outcome = await local.verifyLocalCredentials(opts.db, email, password);
      if (!outcome.ok) {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: null,
          reason: 'invalid_local_credentials',
          ...auditContext(request),
        });
        return invalidCredentials(request, reply);
      }

      // New session id on every authentication: whatever cookie the browser
      // arrived with (possibly one an attacker planted) must not become the
      // authenticated one.
      await request.session.regenerate();

      if (outcome.user.mustChangePassword) {
        // NOT `userId`. See the gate's rationale in
        // packages/auth/src/local/session-gate.ts: a session in this state is
        // rejected by every guarded route in the product precisely because it
        // does not look authenticated to the check they all already make.
        request.session.set('pendingPasswordChangeUserId', outcome.user.id);
        await request.session.save();
        return reply.send({ must_change_password: true });
      }

      request.session.set('userId', outcome.user.id);
      request.session.set('createdAt', Date.now());
      await request.session.save();
      auditLog(request.log, {
        event: 'auth.login.success',
        actorUserId: outcome.user.id,
        ...auditContext(request),
      });
      return reply.send({ must_change_password: false, user: publicUser(outcome.user) });
    },
  );

  // The SPA's way to find out WHY it is getting 401s everywhere. A session
  // pending a password change is deliberately invisible to /me (it has no
  // `userId`), so without this a page reload during the forced change would
  // strand the user on a screen that only says "not signed in".
  app.get('/auth/local/session', async (request, reply) => {
    const pending = request.session?.get('pendingPasswordChangeUserId');
    return reply.send({ pending_password_change: pending !== undefined });
  });

  app.post(
    '/auth/local/password',
    { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } },
    async (request, reply) => {
      // Accepts BOTH session states: the pending one (this is the only thing it
      // may do) and a normal one (a user changing their password voluntarily).
      const pendingUserId = request.session?.get('pendingPasswordChangeUserId');
      const userId = request.session?.get('userId') ?? pendingUserId;
      if (userId === undefined) return problem(request, reply, 401, 'No active session');

      const currentPassword = readString(request.body, 'current_password');
      const newPassword = readString(request.body, 'new_password');
      if (currentPassword === undefined || newPassword === undefined) {
        return problem(request, reply, 400, 'current_password and new_password are required');
      }

      const user = await findUserById(opts.db, userId);
      if (!user) {
        await request.session.destroy();
        return problem(request, reply, 401, 'No active session');
      }
      if (!user.passwordHash) {
        // A federated account has no password to change, and inventing one here
        // would silently give a GitHub-only user a second way in.
        return problem(request, reply, 400, 'This account does not use a password');
      }

      const check = await local.verifyPassword(user.passwordHash, currentPassword);
      if (!check.ok) {
        auditLog(request.log, {
          event: 'auth.login.failure',
          actorUserId: user.id,
          reason: 'password_change_wrong_current',
          ...auditContext(request),
        });
        return problem(request, reply, 401, 'Current password is incorrect');
      }
      if (newPassword === currentPassword) {
        // The forced change exists because someone else knows the old password;
        // "changing" it to itself would satisfy the flag and not the reason.
        return problem(request, reply, 400, 'New password must differ from the current one');
      }

      const result = await local.setLocalPassword(opts.db, user.id, newPassword);
      if (!result.ok) {
        return problem(request, reply, 400, 'Password rejected', result.detail);
      }

      // A credential change invalidates the old session id, and it is also what
      // PROMOTES a pending session into a real one — the single moment the gate
      // opens, and it cannot happen without a new password being stored.
      await request.session.regenerate();
      request.session.set('userId', user.id);
      request.session.set('createdAt', Date.now());
      await request.session.save();

      // W20-10 (UX_TODO ADM-78). The change exists because someone else may
      // know the old password, so every OTHER session of this account ends
      // here — including the pre-change one, which regenerate() leaves in the
      // store. Only this browser stays signed in.
      const signedOut =
        (await app.sessionStore?.destroyUserSessions(user.id, request.session.sessionId)) ?? 0;

      auditLog(request.log, {
        event: 'auth.login.success',
        actorUserId: user.id,
        reason: 'password_changed',
        other_sessions_ended: signedOut,
        ...auditContext(request),
      });
      return reply.send({
        user: { ...publicUser(user), must_change_password: false },
        other_sessions_signed_out: signedOut,
      });
    },
  );

  // "Sign out everywhere" (W20-10, UX_TODO ADM-78): ends every session this
  // account holds, this one included. For someone who left a session open on a
  // shared or lost machine; logout only ever ended the current one.
  app.post(
    '/auth/sessions/revoke-all',
    { config: { rateLimit: AUTH_FLOW_RATE_LIMIT } },
    async (request, reply) => {
      const userId = request.session?.get('userId');
      if (userId === undefined) return problem(request, reply, 401, 'No active session');
      if (!app.sessionStore) {
        return problem(request, reply, 503, 'Sessions cannot be listed on this server');
      }
      const others = await app.sessionStore.destroyUserSessions(userId, request.session.sessionId);
      await request.session.destroy();
      auditLog(request.log, {
        event: 'auth.session.revoked',
        actorUserId: userId,
        scope: 'all',
        sessions_ended: others + 1,
        ...auditContext(request),
      });
      return reply.send({ sessions_ended: others + 1 });
    },
  );

  // /auth/logout only destroys a session that carries `userId`, so a session
  // pending a password change cannot be logged out there. Rather than edit that
  // route, this one destroys whatever session exists — a user who cannot
  // complete the change must still be able to walk away.
  app.post('/auth/local/logout', async (request, reply) => {
    const pending = request.session?.get('pendingPasswordChangeUserId');
    const userId = request.session?.get('userId');
    if (pending !== undefined || userId !== undefined) {
      await request.session.destroy();
      auditLog(request.log, {
        event: 'auth.logout',
        actorUserId: userId ?? pending ?? null,
        ...auditContext(request),
      });
    }
    return reply.code(204).send();
  });

  // Admin-created accounts (acceptance 4). Without this a fresh install has
  // exactly one account for ever.
  //
  // It lives here rather than under /api/v1/admin because it is an
  // authentication concern and because /api/v1 is not this module's to extend;
  // the consequence is that the admin check has to be made explicitly instead
  // of inherited, which is what the two lines below are.
  app.post('/auth/local/users', async (request, reply) => {
    // Reads `userId` ONLY. A session pending its own password change carries no
    // `userId`, so it cannot create accounts — which is the gate doing its job
    // on a route that never mentions it.
    const actorId = request.session?.get('userId');
    if (actorId === undefined) return problem(request, reply, 401, 'No active session');
    const membership = await workspaceModule.ensureMembership(opts.db, actorId);
    if (membership.role !== 'admin') {
      return problem(request, reply, 403, 'Forbidden — admin role required');
    }

    const email = readString(request.body, 'email');
    if (email === undefined) return problem(request, reply, 400, 'email is required');
    // W20-19 (UX_TODO INS-62): the admin may choose the role up front, rather
    // than create a member and then find the row to promote.
    const role = readString(request.body, 'role') ?? 'member';
    if (role !== 'member' && role !== 'admin') {
      return problem(request, reply, 400, 'Invalid role', 'role must be one of admin, member');
    }

    // An admin may set the first password or let us pick one. Picking one is
    // the better default — a human-chosen "temporary" password is usually a
    // pattern, and this one only has to survive being pasted into a chat window
    // once. It is returned exactly once, here, and is unreadable afterwards.
    const supplied = readString(request.body, 'password');
    const password = supplied ?? randomBytes(24).toString('base64url');

    const created = await local.createLocalUser(opts.db, {
      email,
      password,
      ...(readString(request.body, 'login') !== undefined
        ? { login: readString(request.body, 'login') }
        : {}),
      ...(readString(request.body, 'name') !== undefined
        ? { name: readString(request.body, 'name') }
        : {}),
      // Always. The admin who typed or received this password is not the person
      // who will own the account.
      mustChangePassword: true,
    });

    if (!created.ok) {
      if (created.reason === 'exists') {
        return problem(request, reply, 409, 'An account with that email already exists');
      }
      return problem(
        request,
        reply,
        400,
        created.reason === 'invalid_email' ? 'Invalid email address' : 'Password rejected',
        created.detail,
      );
    }

    // Auto-membership normally happens on the new user's first authenticated
    // request; doing it now means the admin's Members list shows them straight
    // away instead of after they first sign in.
    const joined = await workspaceModule.ensureMembership(opts.db, created.user.id);
    if (role === 'admin' && joined.role !== 'admin') {
      await opts.db
        .update(core.workspaceMembers)
        .set({ role: 'admin' })
        .where(
          and(
            eq(core.workspaceMembers.workspaceId, joined.workspace.id),
            eq(core.workspaceMembers.userId, created.user.id),
          ),
        );
    }

    // Who added whom, as what. NEVER the password: audit entries are logged
    // and persisted, and the one-time password exists only in this response.
    auditLog(request.log, {
      event: 'admin.member.created',
      actorUserId: actorId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      workspaceId: joined.workspace.id,
      targetUserId: created.user.id,
      targetLogin: created.user.login,
      role,
      passwordGenerated: supplied === undefined,
    });

    return reply.code(201).send({
      user: publicUser(created.user),
      role,
      ...(opts.signInUrl ? { sign_in_url: opts.signInUrl } : {}),
      // Present only when WE generated it. Echoing back a password the admin
      // supplied would put it in a second place for no benefit.
      ...(supplied === undefined ? { temporary_password: password } : {}),
    });
  });
}

export default fp(localAuthRoutes, { name: '@repopulse/api-local-auth-routes' });
