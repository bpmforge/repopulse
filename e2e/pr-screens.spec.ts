import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';
import { SEED_REPO_NAMES } from '@repopulse/shared';

// W4-05: repo PR list → PR detail, with the list filter living in the URL.

// A SEEDED repo, located by name rather than by position. Every assertion below
// depends on seeder shape (5 PRs, reviews, checks), but the ingest specs add
// real ingested repos to this same workspace — and since those now reach `live`
// they can render ahead of the seeded ones. Taking the first tile silently
// pointed this spec at a 2-PR ingested repo and failed on counts that were
// never about it.
async function seededRepoId(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/?window=90d');
  const tile = page
    .getByTestId('health-tile-grid')
    .locator('a')
    .filter({ hasText: SEED_REPO_NAMES[0] });
  await expect(tile.first(), `seeded repo "${SEED_REPO_NAMES[0]}" should be on the org overview`)
    .toBeVisible();
  const href = await tile.first().getAttribute('href');
  const id = href?.match(/\/repos\/(\d+)/)?.[1];
  if (!id) throw new Error('no repo link on the org overview');
  return id;
}

test('the PR list renders seeded PRs and drills into detail', async ({ page }) => {
  await loginAsFixture(page);
  const repoId = await seededRepoId(page);
  await page.goto(`/repos/${repoId}/prs?window=90d`);

  // Row count, not mere visibility: the seeder writes 5 PRs per repo, and the
  // table container renders whether or not any rows arrived.
  const rows = page.getByTestId('pr-list').locator('tbody tr');
  await expect(rows).toHaveCount(5);

  await page.getByTestId('pr-list').locator('tbody a').first().click();
  await expect(page).toHaveURL(/\/repos\/\d+\/prs\/\d+/);
  await expect(page.getByTestId('pr-detail')).toBeVisible();
  // Title resolves only after /repos/{id}/prs/{number} returns.
  await expect(page.getByTestId('pr-title')).toContainText('#');
});

test('the state filter is URL state, not component state', async ({ page }) => {
  await loginAsFixture(page);
  const repoId = await seededRepoId(page);
  await page.goto(`/repos/${repoId}/prs?window=90d`);

  await page.getByTestId('pr-state-filter').selectOption('merged');
  // The whole point of putting it in the URL: it must be linkable.
  await expect(page).toHaveURL(/state=merged/);
  await expect(page).toHaveURL(/window=90d/);

  // Seeder makes 3 of 5 merged, so the filter has to actually narrow — an
  // unchanged count would mean the param rides the URL but never reaches the
  // query.
  await expect(page.getByTestId('pr-list').locator('tbody tr')).toHaveCount(3);

  // And it must restore on a cold paste, with no click history.
  await page.goto(`/repos/${repoId}/prs?window=90d&state=merged`);
  await expect(page.getByTestId('pr-state-filter')).toHaveValue('merged');
  await expect(page.getByTestId('pr-list').locator('tbody tr')).toHaveCount(3);
});

test('PR detail shows the stage timeline, reviews, checks and files', async ({ page }) => {
  await loginAsFixture(page);
  const repoId = await seededRepoId(page);
  await page.goto(`/repos/${repoId}/prs?window=90d&state=merged`);
  await page.getByTestId('pr-list').locator('tbody a').first().click();

  await expect(page.getByTestId('pr-stages').locator('li')).not.toHaveCount(0);
  // A merged PR has no running clock, so the elapsed/pulsing stage must be
  // absent — its presence would mean toStages mislabelled a finished PR.
  await expect(page.getByTestId('pr-stage-elapsed')).toHaveCount(0);
  await expect(page.getByTestId('pr-files').locator('tbody tr')).not.toHaveCount(0);
  await expect(page.getByTestId('pr-reviews')).toBeVisible();
});

test('an open PR shows a running stage', async ({ page }) => {
  await loginAsFixture(page);
  const repoId = await seededRepoId(page);
  await page.goto(`/repos/${repoId}/prs?window=90d&state=open`);
  await page.getByTestId('pr-list').locator('tbody a').first().click();
  // The counterpart to the assertion above: an open PR's clock IS running, so
  // together they prove toStages branches on merged_at rather than always
  // picking one shape.
  await expect(page.getByTestId('pr-stage-elapsed')).toHaveCount(1);
});

test('PR screens pass axe with real data', async ({ page }) => {
  await loginAsFixture(page);
  const repoId = await seededRepoId(page);
  await page.goto(`/repos/${repoId}/prs?window=90d`);
  await expect(page.getByTestId('pr-list').locator('tbody tr').first()).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByTestId('pr-list').locator('tbody a').first().click();
  await expect(page.getByTestId('pr-detail')).toBeVisible();
  await expectNoA11yViolations(page);
});

test('the /pull-requests screen is the org-wide list, not a repo picker (W4-16)', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/pull-requests');

  // This screen was a repo picker for a real reason — no endpoint returned an
  // org-wide list, and fanning one request per repo out of the browser is an
  // N+1 against the p95 <500ms budget. W4-16 added GET /prs.
  await expect(page.getByTestId('org-pr-list')).toBeVisible();
  await expect(page.getByTestId('pr-repo-picker')).toHaveCount(0);

  const rows = page.getByTestId('org-pr-rows').locator('tr');
  await expect(rows).not.toHaveCount(0);

  // ACROSS repos, which is the whole point: a list showing one repo's PRs would
  // satisfy every assertion above while still being the old screen.
  // `td:first-child` per row — NOT rows.locator('td').first(), which is the
  // first cell of the first row and would collapse every check to one value.
  const repoCells = await rows.locator('td:first-child').allInnerTexts();
  const distinctRepos = new Set(repoCells.map((t) => t.trim()).filter(Boolean));
  expect(distinctRepos.size, 'org-wide list should span more than one repo').toBeGreaterThan(1);
});

test('org PR filters narrow the list server-side (W4-16)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/pull-requests');

  const rows = page.getByTestId('org-pr-rows').locator('tr');
  await expect(rows).not.toHaveCount(0);
  const before = await rows.count();

  await page.getByTestId('pr-filter-state').selectOption('merged');
  // POLLED, not read once: allInnerTexts does not auto-wait, so reading
  // straight after the change asserts against the pre-refetch DOM and passes or
  // fails on timing rather than on behaviour.
  await expect
    .poll(async () => {
      const states = await rows.locator('td:nth-last-child(2)').allInnerTexts();
      // Every visible row matches — a filter applied client-side to an already
      // paginated page would leave non-matching rows behind.
      return states.length > 0 && states.every((s) => s.trim() === 'merged');
    })
    .toBe(true);
  expect(await rows.count()).toBeLessThanOrEqual(before);

  await page.getByTestId('pr-filter-unreviewed').check();
  await expect
    .poll(async () => {
      const reviewed = await rows.locator('td:last-child').allInnerTexts();
      // An empty result is a legitimate answer here (every merged PR in the
      // fixture may have been reviewed), so "no rows" counts as consistent.
      return reviewed.every((r) => r.includes('no'));
    })
    .toBe(true);
});
