import { expect, type Page } from '@playwright/test';
import { FIXTURE_LOGIN } from '@repopulse/shared';

// Login as the seeded fixture user (docs/TESTING.md §6). OAuth is mocked at the
// boundary only — e2e/server.ts points the API's GitHub authorize/token/user
// URLs at e2e/helpers/fake-github.ts, which returns the fixture identity
// (forge_user_id = the seeder's FIXTURE_LOGIN). Everything else is the real
// path: /auth/login sets the real signed state cookie, the callback verifies
// it, exchanges the code over HTTP, and saves a real Redis session.
export async function loginAsFixture(page: Page): Promise<void> {
  // The session normally arrives via storageState (globalSetup logs in once —
  // SC-11 caps the auth flow at 10/min, so a login per spec exhausts it as soon
  // as the suite grows). Verify it rather than re-running the round trip, and
  // only log in when a spec deliberately uses a fresh context.
  const existing = await page.request.get('/api/v1/me/context');
  if (existing.status() !== 200) {
    await page.goto('/auth/login');
    await page.waitForURL((url) => !url.pathname.startsWith('/auth/'), { timeout: 10_000 });
  }

  const res = await page.request.get('/api/v1/me/prs');
  expect(
    res.status(),
    'authenticated /api/v1/me/prs should be 200 — a 401 means the session never persisted',
  ).toBe(200);
}

export { FIXTURE_LOGIN };
