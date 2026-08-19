import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { installEgressGuard } from './helpers/egress-guard.js';
import {
  FAKE_CHECKS,
  FAKE_COMMITS,
  FAKE_COMMIT_FILES,
  FAKE_PRS,
  FAKE_REPOS,
  FAKE_REVIEWS,
  FAKE_TOKEN,
} from '@repopulse/shared';
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
test('the full pipeline runs: history backfilled, enrichment drained, repo live', async ({
  page,
}) => {
  test.setTimeout(90_000); // async: plan → 5 entity jobs → enrich fan-out → snapshot

  // W12-02 acceptance 4. This is the one flow that genuinely talks to a forge,
  // so it is the one where "nothing reached a real forge host" is worth
  // asserting rather than assuming.
  const guard = await installEgressGuard(page);
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

  // ENRICHMENT (W12-05): per-commit file churn. This is the phase that was
  // missing entirely — no producer and no consumer — and its absence is why the
  // first ingested repo showed M1/M2 as 0.000000. The count is exact because
  // the fixture is.
  const expectedFiles = FAKE_COMMIT_FILES.slice(0, FAKE_COMMITS.length).reduce(
    (n, files) => n + files.length,
    0,
  );
  expect(ingested.commitFiles).toBe(expectedFiles);

  // Per-PR enrichment: reviews and check runs. upsertReviews and
  // upsertCheckRuns were both fully built and called by NOTHING until
  // enrichment was broadened to cover per-parent detail fetches.
  const flat = <T>(xs: T[][]) => xs.slice(0, FAKE_PRS.length).reduce((n, x) => n + x.length, 0);
  expect(ingested.reviews).toBe(flat(FAKE_REVIEWS));
  // Exact, and it caught a real fixture bug: check runs upsert on
  // (repo, kind, forge_run_id, run_attempt), so per-PR ids restarting at 1 made
  // one PR's check silently overwrite another's.
  expect(ingested.checkRuns).toBe(flat(FAKE_CHECKS));

  // `live` is only reachable once enrichment has DRAINED (INGESTION §2:
  // queued → history → enrichment → live). Asserting it proves the whole state
  // machine ran, not just that some rows landed — a repo that backfilled but
  // never enriched stalls at `backfilling` and fails here.
  expect(ingested.syncStatus).toBe('live');

  // W12-02 acceptance 3: the SCREENS render data that arrived through
  // ingestion rather than through the seeder. Everything above proves rows
  // reached Postgres; this proves the product shows them.
  //
  // The org overview first — beta-web appears in no fixture, so its tile can
  // only exist because the connect flow created the repo.
  await page.goto('/');
  await expect(page.getByTestId('org-overview')).toBeVisible();
  const tile = page.getByTestId(`health-tile-${ingested.repoId}`);
  await expect(tile).toBeVisible();
  await expect(tile).toContainText(name);

  // Then the drill-down, which is the assertion that actually bites. A repo
  // ROW is created by repo selection, so a tile alone would still appear if
  // the backfill wrote nothing — these PR rows exist ONLY because the GraphQL
  // backfill ingested them, so they cannot pass on repo-selection alone.
  await page.goto(`/repos/${ingested.repoId}/prs?window=90d`);
  for (const pr of FAKE_PRS) {
    await expect(
      page.getByTestId(`pr-link-${pr.number}`),
      `PR #${pr.number} was ingested over GraphQL and must appear on the PR list`,
    ).toBeVisible();
  }

  // PR detail renders the enriched data. These sections were empty for every
  // ingested repo until reviews/checks had a lane — the visible symptom of the
  // gap, and the reason asserting the warehouse alone would not have been
  // enough.
  await page.goto(`/repos/${ingested.repoId}/prs/${FAKE_PRS[0]!.number}?window=90d`);
  await expect(page.getByTestId('pr-detail')).toBeVisible();
  await expect(page.getByTestId('pr-reviews')).toBeVisible();
  await expect(page.getByTestId('pr-checks')).toBeVisible();

  guard.assertNoForbidden();
});
