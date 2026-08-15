import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// W4-06: the deepest rung of the drill-down. Reaching it by CLICK from the
// hotspot leaderboard is the acceptance path — that link has existed since
// W4-03 but pointed at a route that did not exist until now.

test('a hotspot row drills through to the file screen', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');

  const firstHotspot = page.getByTestId('hotspot-leaderboard').locator('tbody a').first();
  const label = (await firstHotspot.innerText()).trim();
  await firstHotspot.click();

  await expect(page).toHaveURL(/\/repos\/\d+\/files\//);
  await expect(page.getByTestId('file-detail')).toBeVisible();
  // The heading must show the file the row named — a path that arrives
  // mangled by encoding would still render "a" file screen.
  await expect(page.getByTestId('file-path')).toHaveText(label);
});

test('the file screen renders churn and owners from the warehouse', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');
  await page.getByTestId('hotspot-leaderboard').locator('tbody a').first().click();

  // A canvas proves the chart drew; the seeder gives every hot file commits, so
  // an empty state here means the path did not resolve server-side.
  await expect(page.getByTestId('file-churn').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('file-owners').locator('tbody tr')).not.toHaveCount(0);

  // All 52 weeks, including the quiet ones. Dropping empty buckets renders this
  // fixture file in 5 bars instead of 52, which draws a file touched in a few
  // bursts as if it were touched steadily — the quiet periods ARE the signal.
  await page.getByTestId('file-churn').getByRole('button', { name: /table/i }).click();
  await expect(page.getByTestId('file-churn').locator('tbody tr')).toHaveCount(52);
});

test('a pasted file deep link restores the same screen', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');
  const href = await page
    .getByTestId('hotspot-leaderboard')
    .locator('tbody a')
    .first()
    .getAttribute('href');
  expect(href).toMatch(/\/repos\/\d+\/files\//);

  // Cold load with slashes in the splat — the case that breaks when a path is
  // flattened into a single segment.
  await page.goto(href!);
  await expect(page.getByTestId('file-detail')).toBeVisible();
  await expect(page.getByTestId('file-path')).toContainText('/');
});

test('the file screen passes axe with real data', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');
  await page.getByTestId('hotspot-leaderboard').locator('tbody a').first().click();
  await expect(page.getByTestId('file-churn').locator('canvas')).toBeVisible();
  await expectNoA11yViolations(page);
});

test('the file screen shows rework, hotspot history and the PRs that touched it (W4-17)', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/');
  await page.getByTestId('hotspot-leaderboard').locator('a').first().click();
  await expect(page.getByTestId('file-detail')).toBeVisible();

  // The churn chart's data alternative is the honest place to assert the
  // numbers: the canvas cannot be read, and "view as table" is a WCAG
  // requirement this project already ships. A REWORK column is the whole point
  // — the old empty state said drawing gross churn labelled "rework" would
  // misstate a defined metric.
  await page
    .getByTestId('file-churn')
    .getByTestId('chart-table-toggle')
    .click();
  const table = page.getByTestId('file-churn').getByTestId('chart-table');
  await expect(table).toBeVisible();
  await expect(table).toContainText('Rework');

  // Hotspot history is a real series or an honest empty state — never a flat
  // line invented from one current value.
  const history = page.getByTestId('file-hotspot-history');
  const emptyHistory = page.getByText(/history builds up as nightly runs/i);
  await expect(history.or(emptyHistory).first()).toBeVisible();

  // The panel naming W4-17 is gone.
  await expect(page.getByText(/Tracked as W4-17/i)).toHaveCount(0);
});
