import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { identity, workspace as workspaceModule } from '@repopulse/auth';
import type { Database } from '@repopulse/shared';
import { sendProblem } from './problem.js';

// What this deployment actually offers, and who the visitor is to it (W15-04, D14).
//
// REGISTRATION (not done by this file — see the report for W15-04): apps/api/src/app.ts
// must add, in the same scope and AFTER `authRoutes` so the session decorator exists:
//
//   app.register(authProviderRoutes, {
//     db: opts.db,
//     ...(opts.oidc ? { oidc: { displayName: opts.oidc.displayName } } : {}),
//     github: opts.githubOAuth !== undefined,
//   });
//
// WHY THE ENDPOINT EXISTS AT ALL. Since D14 there are three ways in and a given
// install offers some subset of them: OIDC routes are registered only when the
// environment configured them, /auth/login only when a GitHub App exists, and
// local accounts always. The browser cannot infer any of that — it would have to
// probe routes and read 404s as configuration — so a sign-in screen written
// without this endpoint necessarily renders buttons for providers nobody set up.
// Clicking one of those lands on a 404 or, worse, on a vendor's consent screen
// for an App that does not exist. Telling the client the truth once is the whole
// job.
//
// It is UNAUTHENTICATED by construction: it is the page a person sees before
// they have any session, and it discloses only which doors are on the building,
// never an issuer URL, a client id, or whether a given email has an account.

export interface AuthProviderRoutesOptions {
  db: Database;
  /** Absent when this deployment did not configure OIDC. */
  oidc?: { displayName: string } | undefined;
  /** True when a GitHub App is configured, i.e. /auth/login was registered. */
  github?: boolean | undefined;
  /**
   * The demo credentials, when this process is the demo entrypoint (W16-02).
   *
   * The sign-in screen is the ONE screen that cannot ask /me/context whether
   * this is a demo — there is no session yet, so it answers 401 — which is why
   * it was the one screen with no demo banner on it (F2). This endpoint is
   * already unauthenticated and already exists to tell the browser what this
   * deployment offers, so the demo's own credentials belong here rather than in
   * a second anonymous endpoint.
   *
   * Publishing a password from an API is only acceptable because demo mode
   * cannot boot under NODE_ENV=production, and because this field is populated
   * solely by the demo entrypoint — the production entrypoint never passes it,
   * so a real install cannot emit one even if it wanted to.
   */
  demo?: { email: string; password: string } | undefined;
}

async function authProviderRoutes(
  app: FastifyInstance,
  opts: AuthProviderRoutesOptions,
): Promise<void> {
  app.get('/auth/providers', async (_request, reply) => {
    return reply.send({
      // Always true. Local accounts are what make this product installable
      // without registering an App with anybody (D14), so there is no
      // deployment in which the password form should be hidden.
      local: true,
      oidc: opts.oidc ? { display_name: opts.oidc.displayName } : null,
      github: opts.github === true,
      demo: opts.demo ? { email: opts.demo.email, password: opts.demo.password } : null,
    });
  });

  // Why a personalized view is empty (D14, FR-AUTH-6).
  //
  // /me/context already returns `identity_id`, but null there means two
  // different things — "this account is not connected to any committer" and
  // "it is connected and nothing of theirs has been ingested" — and only one of
  // them is about the person's work. `identityLinkState` is the function that
  // separates them; until now nothing served it, so the UI had no way to avoid
  // showing a local or OIDC user a 0 as though it were an answer.
  //
  // It lives beside /auth/providers rather than under /api/v1 because both
  // answer "what is my relationship to this install", and because /api/v1 is
  // not this module's to extend. The cost is that the session check is made
  // explicitly here instead of inherited from the api-v1 preHandler.
  app.get('/auth/identity', async (request, reply) => {
    const userId = request.session?.get('userId');
    if (userId === undefined) {
      sendProblem(request, reply, 401, 'No active session');
      return reply;
    }

    // The workspace comes from the membership rather than from
    // `request.workspace`: that decoration is applied by the api-v1 preHandler,
    // which does not run on /auth routes. `ensureMembership` is the same call
    // the local admin route next door makes for the same reason.
    // Same dead-session case as the api-v1 preHandler (W16-15): this route does
    // its own membership call, so it needs its own answer.
    let membership;
    try {
      membership = await workspaceModule.ensureMembership(opts.db, userId);
    } catch (err) {
      if (err instanceof workspaceModule.UnknownUserError) {
        sendProblem(request, reply, 401, 'No active session');
        return reply;
      }
      throw err;
    }
    const link = await identity.identityLinkState(opts.db, membership.workspace.id, userId);

    return reply.send({
      state: link.state,
      identity_id: link.state === 'linked' ? link.identityId : null,
    });
  });
}

export default fp(authProviderRoutes, { name: '@repopulse/api-auth-provider-routes' });
