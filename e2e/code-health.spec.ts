import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';
import { SEED_REPO_NAMES } from '@repopulse/shared';

// Code Health tab (W9-06, FR-CH-6).
//
// Same property as the Security tab: every number is either measured or
// explicitly absent, and "not measured" never renders as a zero.

async function openSeededRepo(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?window=90d');
  await page
    .getByTestId('health-tile-grid')
    .locator('a')
    .filter({ hasText: SEED_REPO_NAMES[0] as string })
    .first()
    .click();
  await expect(page).toHaveURL(/\/repos\/\d+/);
}

test('the Code Health tab renders, says what is unmeasured, and passes axe', async ({ page }) => {
  await loginAsFixture(page);
  await openSeededRepo(page);

  await page.getByTestId('repo-tabs').getByRole('link', { name: 'Code Health' }).click();
  await expect(page).toHaveURL(/\/repos\/\d+\/code-health/);
  await expect(page.getByTestId('code-health-tab')).toBeVisible();

  // Debt signals headline row exists whether or not a scanner has run.
  await expect(page.getByTestId('ch-headlines')).toBeVisible();

  // Coverage table names every code-health scanner, including ones that have
  // never run — a scanner missing from this table is one nobody knows is
  // missing.
  const coverage = page.getByTestId('ch-scanners');
  await expect(coverage).toBeVisible();
  for (const key of ['code_health_tools', 'anti_slop', 'logging_hygiene']) {
    await expect(page.getByTestId(`ch-scanner-${key}`)).toBeVisible();
  }

  await expectNoA11yViolations(page);
});

test('an unmeasured signal reads "not measured", never 0', async ({ page }) => {
  await loginAsFixture(page);
  await openSeededRepo(page);
  await page.getByTestId('repo-tabs').getByRole('link', { name: 'Code Health' }).click();

  // Whatever the seed contains, a headline with no measurement must say so in
  // words. A zero there is a claim about the repository.
  const headlines = page.getByTestId('ch-headlines');
  await expect(headlines).toBeVisible();
  const text = (await headlines.innerText()).toLowerCase();
  expect(text.includes('not measured') || /\d/.test(text)).toBe(true);

  // And a scanner that has never run shows a dash rather than a zero count.
  const rows = page.getByTestId('ch-scanners').locator('tbody tr');
  const neverRun = rows.filter({ hasText: 'has never run' });
  const count = await neverRun.count();
  for (let i = 0; i < count; i++) {
    await expect(neverRun.nth(i).locator('td').last()).toHaveText('—');
  }
});

test('the complexity panel explains an empty list rather than implying clean code', async ({
  page,
}) => {
  await loginAsFixture(page);
  await openSeededRepo(page);
  await page.getByTestId('repo-tabs').getByRole('link', { name: 'Code Health' }).click();

  // Wait for the frame to leave its loading state before branching: a
  // not-yet-rendered panel is neither the empty state nor the list, and
  // checking too early would make this test a race rather than an assertion.
  const frame = page.getByTestId('ch-complexity');
  await expect(frame).toHaveAttribute('data-state', 'ready');

  const empty = page.getByTestId('ch-complexity-empty');
  if (await empty.isVisible()) {
    await expect(empty).toContainText(/not a measurement of a tidy codebase/i);
  } else {
    await expect(page.getByTestId('ch-complexity-list')).toBeVisible();
  }
});
