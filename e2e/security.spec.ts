import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';
import { SEED_REPO_NAMES } from '@repopulse/shared';

// Security tab + scanner facets (W8-10, SECURITY_SUITE.md §5, NFR-15).
//
// The property under test is the one this screen exists for: a security page
// must never let "nobody looked" read as "nothing found". Every assertion below
// is about a sentence being present, not about a number.

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

test('the Security tab says what has NOT been looked at, and passes axe', async ({ page }) => {
  await loginAsFixture(page);
  await openSeededRepo(page);

  await page.getByTestId('repo-tabs').getByRole('link', { name: 'Security' }).click();
  await expect(page).toHaveURL(/\/repos\/\d+\/security/);
  await expect(page.getByTestId('security-tab')).toBeVisible();

  // Coverage table: every scanner in the catalog, including the ones that have
  // never run. A scanner missing from this table is a scanner nobody knows is
  // missing.
  const coverage = page.getByTestId('scanner-status');
  await expect(coverage).toBeVisible();
  // "ran —" covers the W16-49 state: a scan that finished without fault and
  // left findings open, which is not "ran clean" and must not be called it.
  await expect(coverage).toContainText(/not enabled|has never run|ran clean|ran —/);

  // The CVE panel is empty and SAYS WHY — "no dependency scan has run" rather
  // than a blank panel that reads as a clean bill of health.
  await expect(page.getByTestId('cves-empty')).toContainText(/not a clean bill of health/i);

  // W19-12: the AI review pass moved to its own tab; a line here points to it.
  await expect(page.getByTestId('security-ai-pass-moved')).toContainText(/AI Review/);

  // Chains: "has not run" rather than "no chains", because those differ.
  await expect(page.getByTestId('chains-empty')).toContainText(/has not run/i);

  await expectNoA11yViolations(page);
});

for (const theme of ['dark', 'light'] as const) {
  test(`the AI Review tab: a pass not yet run, a schedule off until acknowledged, axe-clean in the ${theme} theme`, async ({
    page,
  }) => {
    await loginAsFixture(page);
    await openSeededRepo(page);
    await page.getByTestId('repo-tabs').getByRole('link', { name: 'AI Review' }).click();
    await expect(page).toHaveURL(/\/repos\/\d+\/ai-review/);
    await expect(page.getByTestId('ai-review-tab')).toBeVisible();

    // W19-10: the AI pass panel says it has not been run, rather than showing an
    // empty list that reads as a clean review, and states its limits up front.
    await expect(page.getByTestId('ai-pass-not-run')).toContainText(/Not yet run/);
    await expect(page.getByTestId('ai-pass-caps')).toContainText(/30 model calls/);
    // W19-11: a pass can review typed paths, a pull request's diff or a commit range.
    await expect(page.getByTestId('ai-pass-mode-pull_request')).toBeVisible();
    await page.getByTestId('ai-pass-mode-commit_range').check();
    await expect(page.getByTestId('ai-pass-base')).toBeVisible();
    await expect(page.getByTestId('ai-pass-start')).toBeDisabled();

    // W19-12: off by default; turning it on shows the acknowledgement and will
    // not save until it is ticked. Nothing is saved here.
    await expect(page.getByTestId('ai-schedule-state')).toContainText(/Off\./);
    await page.getByTestId('ai-schedule-enabled').check();
    await expect(page.getByTestId('ai-schedule-ack-box')).toContainText(
      /without anyone pressing start/,
    );
    await expect(page.getByTestId('ai-schedule-save')).toBeDisabled();
    await page.getByTestId('ai-schedule-ack-check').check();
    await expect(page.getByTestId('ai-schedule-save')).toBeEnabled();

    if (theme === 'light') {
      await page.getByTestId('theme-toggle').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    }
    await expectNoA11yViolations(page);
  });
}

test('a never-run scanner shows a dash, not a zero', async ({ page }) => {
  await loginAsFixture(page);
  await openSeededRepo(page);
  await page.getByTestId('repo-tabs').getByRole('link', { name: 'Security' }).click();

  const rows = page.getByTestId('scanner-status').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  // Whatever the seeded state is, every row that says nothing has looked must
  // show a dash in the count column — a zero there is a claim.
  const unlooked = rows.filter({ hasText: /not enabled|has never run/ });
  const count = await unlooked.count();
  for (let i = 0; i < count; i++) {
    await expect(unlooked.nth(i).locator('td').last()).toHaveText('—');
  }
});

test('the Findings Explorer can filter by scanner, and the tab links into it', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/findings');
  await expect(page.getByTestId('findings')).toBeVisible();

  // The facet exists and is driven by the registry, not a hard-coded list.
  const scannerFilter = page.getByTestId('filter-scanner');
  await expect(scannerFilter).toBeVisible();
  await expect(scannerFilter.locator('option')).not.toHaveCount(1);

  // Secrets is a filterable dimension now: before W8-10 the API dropped an
  // unknown dimension silently, so asking for secrets showed everything.
  await page.getByTestId('filter-status').selectOption('');
  await page.getByTestId('filter-dimension').selectOption('secrets');
  await expect(page.getByTestId('findings')).toBeVisible();

  // And the Security tab drills into that same filtered view.
  await openSeededRepo(page);
  await page.getByTestId('repo-tabs').getByRole('link', { name: 'Security' }).click();
  await page.getByTestId('secrets-drill').click();
  await expect(page).toHaveURL(/\/findings/);
});
