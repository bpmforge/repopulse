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
