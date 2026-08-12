import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { installEgressGuard } from './helpers/egress-guard.js';

// W4-03 acceptance 2: the landing screen renders tiles + sparklines from the
// fixture warehouse, and every number is a door to its evidence (UX_SPEC §1.3).
//
// Every spec pins window=90d rather than using the default. The seeder writes
// ABSOLUTE dates (2026-06-01..06-24), so the default 30d window is empty on any
// run after early July — see W4-13, which fixes the anchoring. Asserting at 90d
// is honest for "renders from the warehouse" but deliberately leaves the default
// path untested; W4-13 owns that assertion.

test('renders the org overview widgets against the seeded warehouse', async ({ page }) => {
  const guard = await installEgressGuard(page);
  await loginAsFixture(page);
  await page.goto('/?window=90d');

  await expect(page.getByTestId('org-overview')).toBeVisible();

  // NOTE: no assertion on KPI VALUES here. The fixture has a single snapshot per
  // metric in one window bucket, so the tiles legitimately render em dashes and
  // no sparkline — see W4-13, which owns both the fixture fix and the value
  // assertion. An earlier version of this spec asserted the row's innerText was
  // non-empty; it passed against five all-em-dash tiles because the LABELS are
  // innerText too. Removed rather than weakened: a test that cannot fail is
  // worse than no test.
  await expect(page.getByTestId('kpi-row')).toBeVisible();

  // seed.ts seeds a 3-repo org in the default workspace; a different count means
  // either the seeder drifted or the second workspace leaked (tenancy, NFR-4).
  await expect(page.getByTestId('health-tile-grid').locator('li')).toHaveCount(3);

  await expect(page.getByTestId('hotspot-leaderboard')).toBeVisible();

  guard.assertNoForbidden();
});

test('a health tile is a door to its repo, carrying the filters', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');

  const firstTile = page.getByTestId('health-tile-grid').locator('a').first();
  const href = await firstTile.getAttribute('href');
  // Assert the door and that the global filter survives the hop (FR-WEB-2). The
  // repo screen itself is W4-04, so this checks the door, not the room behind it.
  expect(href).toMatch(/^\/repos\/\d+/);
  expect(href).toContain('window=90d');

  await firstTile.click();
  await expect(page).toHaveURL(/\/repos\/\d+/);
});

test('a hotspot row is a door to its file drill-down', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');

  const firstRow = page.getByTestId('hotspot-leaderboard').locator('a').first();
  const href = await firstRow.getAttribute('href');
  // W4-06 owns /repos/$repoId/files/$; the path is a splat, so the whole file
  // path rides in the URL rather than being segment-encoded.
  expect(href).toMatch(/^\/repos\/\d+\/files\//);
  expect(href).toContain('window=90d');
});
