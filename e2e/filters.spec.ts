import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';

// W21-01: the top bar's filters change the page you are on, never which page.
//
// The shell's navigate belonged to the ROOT route, so a filter applied with no
// `to` resolved against "/": choosing (or saving) a repository set on Findings
// landed on the Overview, filtered, with nothing on screen saying so.

for (const path of ['/findings', '/pull-requests', '/repos', '/']) {
  test(`choosing repositories on ${path} stays on ${path}, says so, and clears`, async ({
    page,
  }) => {
    await loginAsFixture(page);
    await page.goto(path);
    await expect(page.getByTestId('main')).toBeVisible();

    await page.getByTestId('filter-repos-button').click();
    await page.locator('[data-testid^="filter-repos-option-"]').first().check();
    await page.getByTestId('filter-repos-apply').click();

    await expect(page).toHaveURL(/[?&]repos=/);
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.getByTestId('filter-repos-active')).toContainText('Filtered to 1 repository');

    await page.getByTestId('filter-repos-clear').click();
    await expect(page).not.toHaveURL(/[?&]repos=/);
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.getByTestId('filter-repos-active')).toHaveCount(0);
  });
}

test('saving a repository set keeps you on the page and applies the set there', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/findings');
  await expect(page.getByTestId('findings')).toBeVisible();

  await page.getByTestId('filter-repos-button').click();
  await page.locator('[data-testid^="filter-repos-option-"]').first().check();
  await page.getByTestId('filter-repos-save-set').click();
  await page.getByTestId('filter-repos-set-name').fill(`W21-01 set ${Date.now()}`);
  await page.getByTestId('filter-repos-set-save').click();

  await expect(page).toHaveURL(/\/findings\?.*repos=/);
  await expect(page.getByTestId('filter-repos-active')).toBeVisible();
});

test('the window filter changes the window of the page it is on', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/repos?window=30d');
  await expect(page.getByTestId('repo-list')).toBeVisible();
  await page.getByTestId('filter-window').selectOption('90d');
  await expect(page).toHaveURL(/\/repos\?.*window=90d/);
});
