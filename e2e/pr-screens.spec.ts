import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// W4-05: repo PR list → PR detail, with the list filter living in the URL.

async function firstRepoId(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/?window=90d');
  const href = await page.getByTestId('health-tile-grid').locator('a').first().getAttribute('href');
  const id = href?.match(/\/repos\/(\d+)/)?.[1];
  if (!id) throw new Error('no repo link on the org overview');
  return id;
}

test('the PR list renders seeded PRs and drills into detail', async ({ page }) => {
  await loginAsFixture(page);
  const repoId = await firstRepoId(page);
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
  const repoId = await firstRepoId(page);
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
  const repoId = await firstRepoId(page);
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
  const repoId = await firstRepoId(page);
  await page.goto(`/repos/${repoId}/prs?window=90d&state=open`);
  await page.getByTestId('pr-list').locator('tbody a').first().click();
  // The counterpart to the assertion above: an open PR's clock IS running, so
  // together they prove toStages branches on merged_at rather than always
  // picking one shape.
  await expect(page.getByTestId('pr-stage-elapsed')).toHaveCount(1);
});

test('PR screens pass axe with real data', async ({ page }) => {
  await loginAsFixture(page);
  const repoId = await firstRepoId(page);
  await page.goto(`/repos/${repoId}/prs?window=90d`);
  await expect(page.getByTestId('pr-list').locator('tbody tr').first()).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByTestId('pr-list').locator('tbody a').first().click();
  await expect(page.getByTestId('pr-detail')).toBeVisible();
  await expectNoA11yViolations(page);
});
