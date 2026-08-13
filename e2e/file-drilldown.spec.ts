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
