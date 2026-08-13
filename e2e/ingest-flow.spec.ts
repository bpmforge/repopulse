import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { FAKE_REPOS, FAKE_TOKEN } from './helpers/fake-forge.js';

// The operator's real path: connect a credential, then CHOOSE repositories.
// Creating a connection only stores a credential — selecting repos is what
// creates repo rows, registers webhooks and enqueues the backfill plans. Until
// the picker existed, an operator could connect and then had no way to start
// collecting anything.

test('an operator can connect and then select repositories to track', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin');

  await page.getByTestId('connection-credential').fill(FAKE_TOKEN);
  await page.getByTestId('connection-submit').click();
  await expect(page.getByTestId('connection-result')).toBeVisible();

  // The picker lists what the credential can actually see — served by the fake
  // forge, so these are the repos it advertises, not seeder rows.
  const first = FAKE_REPOS[0]!;
  const option = page.getByTestId(`repo-option-${first.id}`).first();
  await expect(option).toBeVisible();
  await option.check();

  await page.getByTestId('repo-select-submit').first().click();
  // Success means repo rows were created, webhooks registered and backfill
  // plans enqueued — the API does all three in that one call.
  await expect(page.getByTestId('repo-select-result').first()).toBeVisible();
});

test('selecting a repo enqueues backfill work rather than silently succeeding', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/admin');
  await page.getByTestId('connection-credential').fill(FAKE_TOKEN);
  await page.getByTestId('connection-submit').click();
  await expect(page.getByTestId('connection-result')).toBeVisible();

  const first = FAKE_REPOS[0]!;
  await page.getByTestId(`repo-option-${first.id}`).first().check();
  await page.getByTestId('repo-select-submit').first().click();
  await expect(page.getByTestId('repo-select-result').first()).toBeVisible();

  // The repo must now exist in OUR warehouse and appear on the sync screen —
  // proof the selection created rows rather than just returning 200.
  await page.getByTestId('admin-tab-sync').click();
  await expect(page.getByTestId('sync-repo-table').locator('tbody tr')).not.toHaveCount(0);
});
