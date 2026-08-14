import type { FastifyInstance } from 'fastify';

// Shared test login (W12-07).
//
// Two problems with the copy of this helper that lived in five test files.
//
// 1. IT HID FAILURES. Every step used `!`, so a login that did not return what
//    was expected surfaced as "Cannot read properties of undefined (reading
//    'value')" from a repo-route test — an error naming neither auth nor the
//    status code. That is what made an intermittent red unreproducible: the
//    message pointed at the wrong subsystem.
//
// 2. IT BURNED THE SC-11 BUDGET. Each call costs TWO requests against
//    /auth/*, which is capped at 10/minute (AUTH_FLOW_RATE_LIMIT). Files
//    logging in five times sat exactly on the cap, so any extra request —
//    a retry, a new test — tipped them into a 429 with no obvious cause.
//    e2e/global-setup.ts already solved this by logging in ONCE per run; the
//    API tests had no equivalent.
//
// The cache is keyed per app instance AND per user, so a file that genuinely
// needs two different identities still gets them, while repeated logins as the
// same user cost nothing. Tests that specifically exercise the auth flow or the
// limiter should call the app directly rather than use this.

const sessions = new WeakMap<FastifyInstance, Map<string, string>>();

function fail(step: string, status: number, body: string): never {
  throw new Error(
    `test login failed at ${step}: HTTP ${status}. ` +
      `A 429 here means the SC-11 auth limit (10/min) was exhausted — reuse the ` +
      `cached session instead of logging in again. Body: ${body.slice(0, 200)}`,
  );
}

/**
 * Log in through the real OAuth round trip and return the session cookie,
 * reusing a cached session for the same app + user.
 */
export async function loginAs(app: FastifyInstance, forgeUserId: string): Promise<string> {
  let perApp = sessions.get(app);
  if (!perApp) {
    perApp = new Map();
    sessions.set(app, perApp);
  }
  const cached = perApp.get(forgeUserId);
  if (cached) return cached;

  const loginRes = await app.inject({ method: 'GET', url: '/auth/login' });
  if (loginRes.statusCode >= 400) fail('GET /auth/login', loginRes.statusCode, loginRes.body);

  const location = loginRes.headers.location;
  if (typeof location !== 'string') {
    fail('GET /auth/login (no redirect)', loginRes.statusCode, loginRes.body);
  }
  const state = new URL(location).searchParams.get('state');
  const stateCookie = loginRes.cookies.find((c) => c.name === 'oauth_state');
  if (!state || !stateCookie) {
    fail('GET /auth/login (no oauth_state)', loginRes.statusCode, loginRes.body);
  }

  const cbRes = await app.inject({
    method: 'GET',
    url: '/auth/callback',
    query: { code: forgeUserId, state },
    cookies: { oauth_state: stateCookie.value },
  });
  if (cbRes.statusCode >= 400) fail('GET /auth/callback', cbRes.statusCode, cbRes.body);

  const sid = cbRes.cookies.find((c) => c.name === 'repopulse_sid');
  if (!sid) fail('GET /auth/callback (no session cookie)', cbRes.statusCode, cbRes.body);

  perApp.set(forgeUserId, sid.value);
  return sid.value;
}

/** Drop cached sessions for an app — for tests that assert on logout/expiry. */
export function clearLoginCache(app: FastifyInstance): void {
  sessions.delete(app);
}
