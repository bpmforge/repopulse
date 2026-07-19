import { expect, type Page } from '@playwright/test';

// Login as the seeded fixture user (docs/TESTING.md §6). OAuth is mocked at the
// boundary: the e2e API server points its GitHub token/user endpoints at a
// local fake that returns the fixture identity (forge_user_id = the seeder's
// FIXTURE_LOGIN), so /auth/login → authorize → callback completes the REAL
// session/cookie path without touching github.com.
export async function loginAsFixture(page: Page): Promise<void> {
  await page.goto('/auth/login');
  // The mocked API redirects back to the SPA authenticated; the shell renders
  // once the session cookie is set. Screen specs assert their own landing URL.
  await expect(page.locator('body')).toBeVisible();
}
