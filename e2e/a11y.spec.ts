import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// W4-12: the standing contrast assertion, on a POPULATED route in BOTH themes.
//
// This is the gap that let the defect ship. The shell smoke scans an
// unauthenticated page, where the API 401s and no badge ever renders; the web
// component tests run in jsdom, which cannot compute contrast at all. The
// violation only exists when a SeverityBadge or HealthBadge is on screen with
// real data behind it — so that is what this scans.

test('populated org overview passes axe in the dark theme', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/');
  // Badges only render once data lands; scanning before that is the same blind
  // spot as scanning the logged-out shell.
  await expect(page.getByTestId('health-tile-grid').locator('li').first()).toBeVisible();
  await expectNoA11yViolations(page);
});

test('populated org overview passes axe in the light theme', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('health-tile-grid').locator('li').first()).toBeVisible();

  // Light was the worse theme — all six badge tokens failed there, versus two
  // in dark — and it is only reachable through the toggle, so a dark-only scan
  // would have kept missing it.
  await page.getByTestId('theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectNoA11yViolations(page);
});

// W7-04: every route added after W4-12 wrote the spec above, in BOTH themes.
//
// The existing scans covered the Org Overview only. Findings, Plans, Reports
// and Views all landed later — and the light theme is where contrast fails
// first, so a route that was never scanned there was never really checked. The
// text-fg-faint fix in this ticket was found exactly this way.
const ROUTES: { path: string; ready: string }[] = [
  { path: '/findings', ready: 'findings' },
  { path: '/plans', ready: 'plans' },
  { path: '/reports', ready: 'report-center' },
  { path: '/views', ready: 'views' },
  { path: '/me', ready: 'main' },
  { path: '/admin/identities', ready: 'identities' },
  { path: '/admin/agreements', ready: 'agreements' },
];

for (const theme of ['dark', 'light'] as const) {
  for (const route of ROUTES) {
    test(`${route.path} passes axe in the ${theme} theme`, async ({ page }) => {
      await loginAsFixture(page);
      await page.goto(route.path);
      // Wait for the screen's own root, not a timer: scanning a skeleton is
      // how a contrast defect survives an a11y suite.
      await expect(page.getByTestId(route.ready)).toBeVisible();
      if (theme === 'light') {
        await page.getByTestId('theme-toggle').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      }
      await expectNoA11yViolations(page);
    });
  }
}
