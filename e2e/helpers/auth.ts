import { expect, type Page } from '@playwright/test';
import { FIXTURE_LOGIN } from '@repopulse/shared';

// Login as the seeded fixture user (docs/TESTING.md §6). OAuth is mocked at the
// boundary only — e2e/server.ts points the API's GitHub authorize/token/user
// URLs at e2e/helpers/fake-github.ts, which returns the fixture identity
// (forge_user_id = the seeder's FIXTURE_LOGIN). Everything else is the real
// path: /auth/login sets the real signed state cookie, the callback verifies
// it, exchanges the code over HTTP, and saves a real Redis session.
export async function loginAsFixture(page: Page): Promise<void> {
  // Follows: /auth/login → 302 fake authorize → 302 /auth/callback?code&state
  // → 302 loginRedirectUrl. Landing back on the SPA means the whole chain
  // returned 3xx; any 4xx/5xx in the middle leaves us on an error response.
  await page.goto('/auth/login');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/'), { timeout: 10_000 });

  // The session is what we actually care about — assert the server agrees
  // someone is logged in, rather than trusting the redirect chain alone.
  const res = await page.request.get('/api/v1/me/prs');
  expect(
    res.status(),
    'authenticated /api/v1/me/prs should be 200 — a 401 means the session never persisted',
  ).toBe(200);
}

export { FIXTURE_LOGIN };
