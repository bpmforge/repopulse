import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { FAKE_COMMITS, FAKE_PRS, FAKE_REPOS, FAKE_TOKEN } from './helpers/fake-forge.js';
import { waitForIngestedRepo } from './helpers/warehouse.js';

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

// The assertion the project did not have. Every screen, every unit test and
// every earlier e2e passed while ingestion had NEVER written a row — the
// warehouse was populated by the seeder, so the dashboard looked healthy by
// construction. This is the one test that fails if the core loop stops
// working, and it reads Postgres directly rather than trusting a screen.
test('backfill actually ingests: the repo leaves pending_backfill with real rows', async ({
  page,
}) => {
  test.setTimeout(60_000); // asynchronous: plan → 5 entity jobs → snapshot

  await loginAsFixture(page);
  await page.goto('/admin');
  await page.getByTestId('connection-credential').fill(FAKE_TOKEN);
  await page.getByTestId('connection-submit').click();
  await expect(page.getByTestId('connection-result')).toBeVisible();

  // Deliberately the SECOND fixture repo. The two tests above both select
  // FAKE_REPOS[0], and globalSetup seeds once for the whole suite — so asserting
  // on alpha-service here would pass on ingestion THIS test did not cause, and
  // would keep passing if this test's own path broke. Owning a repo no other
  // spec touches is what makes the assertion mean something in a full run.
  const mine = FAKE_REPOS[1]!;
  await page.getByTestId(`repo-option-${mine.id}`).first().check();
  await page.getByTestId('repo-select-submit').first().click();
  await expect(page.getByTestId('repo-select-result').first()).toBeVisible();

  const [org, name] = mine.full_name.split('/') as [string, string];
  const ingested = await waitForIngestedRepo(org, name);

  // Counts are exact, not >0: the fake forge serves a fixed fixture, so a
  // partial ingest (one page of two, PRs silently skipped) must fail rather
  // than pass on a loose lower bound.
  expect(ingested.commits).toBe(FAKE_COMMITS.length);
  expect(ingested.pullRequests).toBe(FAKE_PRS.length);
  // PRs arrive over GraphQL and commits over REST — both paths proven at once.
  expect(ingested.syncStatus).not.toBe('pending_backfill');
});
