import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { installEgressGuard } from './helpers/egress-guard.js';

// W4-03 acceptance 2: the landing screen renders tiles + sparklines from the
// fixture warehouse, and every number is a door to its evidence (UX_SPEC §1.3).
//
// Specs use the DEFAULT window deliberately. W4-13 anchored the fixture to run
// time and gave every metric a weekly series across all four window presets, so
// the default path is the one that must work — pinning a wider window was the
// workaround W4-03 needed before that landed.

test('renders the org overview widgets against the seeded warehouse', async ({ page }) => {
  const guard = await installEgressGuard(page);
  await loginAsFixture(page);
  await page.goto('/');

  await expect(page.getByTestId('org-overview')).toBeVisible();

  // KPI VALUES, not just presence. KpiTile renders an em dash for null, so five
  // tiles appear whether or not the query worked — reading the value spans is
  // what makes this bite. An earlier version asserted the row's innerText was
  // non-empty and passed against five all-em-dash tiles, because the LABELS are
  // innerText too.
  // Retrying assertions throughout, not `.count()` / `.allInnerTexts()`: each
  // sparkline is its own /metrics/series query that resolves AFTER the KPI row
  // paints, so a one-shot read races the data and fails about 1 run in 3.
  await expect(page.getByTestId('kpi-row')).toBeVisible();
  await expect(
    page.getByTestId('kpi-tile').first().locator('div.items-baseline > span').first(),
    'first KPI tile should carry a real value at the default window',
  ).not.toHaveText('—');

  // One sparkline per tile. A sparkline needs >=2 points, so this fails if the
  // fixture regresses to a single snapshot per metric — the W4-13 defect — and
  // the exact count also catches a tile silently losing its series.
  await expect(
    page.getByTestId('kpi-row').locator('svg'),
    'every KPI tile should render a sparkline',
  ).toHaveCount(5);

  // At LEAST the seeder's 3 repos. Not exactly 3: the ingest specs connect a
  // fake forge and legitimately add repos to this same workspace, so an exact
  // count couples this spec to whichever ran first — it failed intermittently
  // once those landed.
  //
  // The tenancy meaning is preserved by the assertion below instead: the
  // second seeded workspace's repo must never appear here (NFR-4), which is
  // what an exact count was really standing in for.
  await expect
    .poll(() => page.getByTestId('health-tile-grid').locator('li').count())
    .toBeGreaterThanOrEqual(3);
  await expect(
    page.getByTestId('health-tile-grid'),
    'no repo from the second workspace may appear (NFR-4)',
  ).not.toContainText('second-tenant');

  await expect(page.getByTestId('hotspot-leaderboard')).toBeVisible();

  guard.assertNoForbidden();
});

test('a health tile is a door to its repo, carrying the filters', async ({ page }) => {
  await loginAsFixture(page);
  // Non-default window on purpose: serializeGlobalSearch omits defaults, so the
  // default window cannot prove a filter survived the hop.
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

test('the sync stream connects — /api/v1/events is mounted', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('org-overview')).toBeVisible();

  // Before the SSE route was mounted this chip read "Reconnecting…" forever,
  // because the client retried against a 404 with backoff. That is the honest
  // rendering of a missing endpoint, which is exactly why it needs an assertion:
  // a dashboard that can never show backfill progress still looks fine.
  //
  // SCOPE (W4-22): this proves the socket OPENS, and nothing more. It passed
  // for months while no code published a single event, so a connected chip and
  // a working stream are different claims. e2e/sync-events.spec.ts asserts the
  // second one — worker publish → Redis → this endpoint → the browser.
  await expect(page.locator('[role="status"]').first()).toHaveText(/live/i, { timeout: 10_000 });
});
