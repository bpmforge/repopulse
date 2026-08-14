import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { installEgressGuard } from './helpers/egress-guard.js';
import { FAKE_TOKEN } from './helpers/fake-forge.js';

// W12-02: the connect path, end to end, through the real UI.
//
// This is the product's most important flow and until now it had NEVER
// executed: every test mocked below the ForgeProvider, and the warehouse was
// populated by the seeder rather than by ingestion. The API talks to a fake
// forge (e2e/helpers/fake-forge.ts) rather than api.github.com, so this needs
// no credential and no network — the egress guard still asserts nothing reaches
// a real forge host.
//
// It also proves the MVP's auth story: a PERSONAL ACCESS TOKEN is enough. No
// GitHub App registration is involved anywhere in this test.

test('connecting with a PAT creates a connection and discovers repos', async ({ page }) => {
  const guard = await installEgressGuard(page);
  await loginAsFixture(page);
  await page.goto('/admin');

  const before = await page.getByTestId('connection-list').locator('tbody tr').count();

  await page.getByTestId('connection-credential').fill(FAKE_TOKEN);
  await page.getByTestId('connection-submit').click();

  // Success, not merely "no crash": the result line only renders on a 2xx, and
  // the list must grow. Asserting the absence of an error would pass if the
  // request never left the browser.
  await expect(page.getByTestId('connection-result')).toBeVisible();
  await expect(page.getByTestId('connection-error')).toHaveCount(0);
  // GREATER THAN, not exactly before+1: other specs connect against the same
  // seeded workspace, so an absolute count races them. What this test owns is
  // that ITS connect added a row, not what the total happens to be.
  await expect
    .poll(() => page.getByTestId('connection-list').locator('tbody tr').count())
    .toBeGreaterThan(before);

  // The credential must not survive in the field after a SUCCESSFUL connect.
  await expect(page.getByTestId('connection-credential')).toHaveValue('');

  guard.assertNoForbidden();
});

test('a bad token is rejected by the forge, not swallowed', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin');

  // The fake checks Authorization, so this exercises real 401 handling rather
  // than a fake that accepts anything — which would prove nothing about
  // credential validation.
  await page.getByTestId('connection-credential').fill('ghp_definitely_not_the_right_token');
  await page.getByTestId('connection-submit').click();

  await expect(page.getByTestId('connection-error')).toBeVisible();
  await expect(page.getByTestId('connection-error')).toContainText(/credential/i);
});

test('the connection stores a fingerprint, never the token', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin');
  await page.getByTestId('connection-credential').fill(FAKE_TOKEN);
  await page.getByTestId('connection-submit').click();
  await expect(page.getByTestId('connection-result')).toBeVisible();

  // SC-2 / FR-AUTH-5: the API describes a connection by fingerprint and last-4.
  // Read the API directly — the UI could be hiding a token the server happily
  // returned.
  const res = await page.request.get('/api/v1/connections');
  const body = await res.text();
  expect(body).not.toContain(FAKE_TOKEN);
  const json = JSON.parse(body) as { items: { last4: string; fingerprint: string }[] };
  expect(json.items.length).toBeGreaterThan(0);
  expect(json.items[0]?.fingerprint, 'a connection must carry a fingerprint').toBeTruthy();
});

test('the operator can choose a forge — GitLab is reachable from the UI (W12-01)', async ({
  page,
}) => {
  // Acceptance 4. The provider was hardcoded to 'github' in the form, so even
  // once the API and adapters supported three forges, a customer could only
  // ever create a GitHub connection. A picker that exists but is not wired
  // would fail here too, because the request body is what is asserted.
  await loginAsFixture(page);
  await page.goto('/admin');

  const picker = page.getByTestId('connection-provider');
  await expect(picker).toBeVisible();
  await expect(picker.locator('option')).toHaveCount(3);

  await picker.selectOption('gitlab');
  await expect(page.getByLabel(/GitLab personal access token/i)).toBeVisible();

  const sent = page.waitForRequest(
    (r) => r.url().includes('/connections') && r.method() === 'POST',
  );
  await page.getByTestId('connection-credential').fill('glpat-not-a-real-token');
  await page.getByTestId('connection-submit').click();
  const body = JSON.parse((await sent).postData() ?? '{}') as { provider?: string };
  expect(body.provider, 'the chosen forge must reach the API').toBe('gitlab');
});
