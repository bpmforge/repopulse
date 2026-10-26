import { expect, test, type Page } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// W4-07: everything on this screen is the caller's OWN data (N-9 forbids
// cross-person comparison), driven by the D6 identity mapping.

test('My Focus is reachable from the rail and shows my own work', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/');

  // Reachability is part of the deliverable: the rail had no entry, so the
  // screen existed but nobody could navigate to it.
  await page
    .getByTestId('rail')
    .getByRole('link', { name: /my focus/i })
    .click();
  await expect(page).toHaveURL(/\/me/);
  await expect(page.getByTestId('my-focus')).toBeVisible();

  // The seeder authors PRs as the fixture login, so these must be populated —
  // an empty list here means the identity mapping did not resolve, which is the
  // failure this screen is most prone to and least able to show.
  //
  // Since W20-12 (DSH-41) the list opens on OPEN pull requests, and the seeded
  // fixture's own PRs may all be merged: then it says how many are hidden and
  // offers them. Either way the rows must be reachable — "Nothing open" with
  // no merged ones behind it would be the mapping failure in disguise.
  await showMyPrs(page);
  await expect(page.getByTestId('my-prs').locator('tbody tr')).not.toHaveCount(0);
  await expect(page.getByTestId('my-hotspots').locator('tbody tr')).not.toHaveCount(0);
});

/** Reveal the merged and closed PRs when none of mine is open (W20-12). */
async function showMyPrs(page: Page): Promise<void> {
  const prs = page.getByTestId('my-prs');
  await expect(
    prs.locator('tbody tr').first().or(page.getByTestId('my-prs-none-open')),
  ).toBeVisible();
  if (await page.getByTestId('my-prs-none-open').isVisible()) {
    await expect(page.getByTestId('my-prs-none-open')).toContainText(/[1-9]\d* merged or closed/);
    await page.getByTestId('my-prs-toggle-closed').click();
  }
}

test('the review queue excludes my own PRs', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/me');
  await expect(page.getByTestId('review-queue')).toBeVisible();

  // FR-AUTH-6: the queue is work awaiting MY review, so a PR I authored must
  // never appear in it.
  //
  // Compared by repo_id + number, NOT by the rendered row text. The seeder gives
  // every repo the same PR titles, so "#4 feature 4" exists in all three repos —
  // a text comparison reported a false overlap and looked exactly like a real
  // tenancy-ish bug until the identities were checked.
  const mine = (await (await page.request.get('/api/v1/me/prs')).json()) as {
    items: { repo_id: number; number: number }[];
  };
  const queue = (await (await page.request.get('/api/v1/me/review-queue')).json()) as {
    items: { repo_id: number; number: number }[];
  };
  const key = (x: { repo_id: number; number: number }) => `${x.repo_id}:${x.number}`;
  const mineKeys = new Set(mine.items.map(key));

  expect(mine.items.length, 'fixture user should author PRs').toBeGreaterThan(0);
  expect(queue.items.length, 'fixture user should have reviews waiting').toBeGreaterThan(0);
  expect(
    queue.items.filter((q) => mineKeys.has(key(q))).map(key),
    'a PR I authored must not be in my review queue',
  ).toEqual([]);
});

test('stats are personal only — no cross-person comparison (N-9)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/me');
  await expect(page.getByTestId('my-stats')).toBeVisible();
  // Guard the non-goal directly: no ranking language anywhere on the screen.
  const text = await page.getByTestId('my-focus').innerText();
  expect(text).not.toMatch(/rank|leaderboard|percentile of|vs\.? team|compared to other/i);
});

test('My Focus passes axe with real data', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/me');
  await showMyPrs(page);
  await expect(page.getByTestId('my-prs').locator('tbody tr').first()).toBeVisible();
  await expectNoA11yViolations(page);
});
