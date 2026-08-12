import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { installEgressGuard } from './helpers/egress-guard.js';

// OAuth round trip (W4-00 acceptance criterion 1): the REAL session/cookie path
// against a GitHub faked at the boundary. This is the criterion the harness was
// missing — every W4 screen spec logs in through loginAsFixture, so if this
// breaks, none of them are testing an authenticated app.

test('unauthenticated personal endpoints are refused', async ({ page }) => {
  // The negative case is what proves the positive case below means anything: if
  // /me/prs answered 200 to everyone, asserting 200 after login would be a test
  // that cannot fail.
  const res = await page.request.get('/api/v1/me/prs');
  expect(res.status(), 'no session should not reach personal data').toBe(401);
});

test('completes the OAuth round trip and lands an authenticated session', async ({ page }) => {
  const guard = await installEgressGuard(page);
  await loginAsFixture(page);
  // Login must never touch a real forge host — the fake is local, so the guard
  // staying clean across a full OAuth chain is a real assertion, not a no-op.
  guard.assertNoForbidden();
});

test('the authenticated session reads the seeded fixture warehouse', async ({ page }) => {
  await loginAsFixture(page);
  const res = await page.request.get('/api/v1/me/prs');
  const body = (await res.json()) as { items: { number: number; title: string }[] };
  // Identity mapping is the part most likely to rot silently, and the route is
  // built to hide it: an unlinked identity returns `{items: []}` with HTTP 200,
  // not an error. So a status check proves nothing here — if the fake's `id`
  // stops matching the seeder's forge_user_id, login still "succeeds" against
  // an orphan user and this is the only assertion that would notice.
  expect(
    body.items.length,
    'fixture user should author seeded PRs — an empty list means the OAuth identity did not resolve to the seeded user',
  ).toBeGreaterThan(0);
});
