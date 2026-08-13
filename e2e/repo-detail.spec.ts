import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// W4-04 acceptance 4: org → repo → tab by CLICKS and by DIRECT URL PASTE
// (FR-WEB-2). Both paths matter and they fail differently — clicking exercises
// the link wiring, pasting exercises route parsing and search validation on a
// cold load with no in-memory router state to fall back on.

async function firstRepoHref(page: import('@playwright/test').Page): Promise<string> {
  const tile = page.getByTestId('health-tile-grid').locator('a').first();
  const href = await tile.getAttribute('href');
  if (!href) throw new Error('no repo link on the org overview');
  return href;
}

test('drills org → repo → each tab by clicking, breadcrumb intact', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');

  await page.getByTestId('health-tile-grid').locator('a').first().click();
  await expect(page).toHaveURL(/\/repos\/\d+/);
  await expect(page.getByTestId('repo-detail')).toBeVisible();
  // The panel testids sit on ALWAYS-rendered containers, so visibility alone
  // proves nothing about data — a probe found every tab 'visible' while the
  // screen was still loading. Assert resolved content instead: the header shows
  // org/name only after /repos/{id} returns, and Pulse draws one chart per
  // metric.
  await expect(page.getByTestId('repo-name')).toContainText('/');
  await expect(page.getByTestId('repo-pulse').locator('canvas')).toHaveCount(4);

  for (const [tab, panel] of [
    ['repo-tab-hotspots', 'repo-hotspots'],
    ['repo-tab-pr-flow', 'repo-pr-flow'],
    ['repo-tab-ci', 'repo-ci'],
  ] as const) {
    await page.getByTestId(tab).click();
    await expect(page.getByTestId(panel)).toBeVisible();
    // Every tab must draw at least one chart from the fixture warehouse.
    await expect(page.getByTestId(panel).locator('canvas').first()).toBeVisible();
    // The tab is a real route, so the URL has to move with it — that is the
    // whole reason tabs are routes and not local state.
    await expect(page).toHaveURL(new RegExp(`/repos/\\d+/${panel.replace('repo-', '')}`));
    // And the global filter must survive every hop, not just the first.
    await expect(page).toHaveURL(/window=90d/);
  }

  await expect(page.getByTestId('breadcrumb')).toBeVisible();
});

test('a pasted deep link restores the identical tab and filters', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');
  const href = await firstRepoHref(page);
  const repoId = href.match(/\/repos\/(\d+)/)?.[1];
  expect(repoId).toBeDefined();

  // Cold navigation straight to a nested tab URL — no click history, no warm
  // router state. This is the FR-WEB-2 case a click-through cannot cover.
  await page.goto(`/repos/${repoId}/hotspots?window=90d`);
  await expect(page.getByTestId('repo-detail')).toBeVisible();
  await expect(page.getByTestId('repo-hotspots')).toBeVisible();
  await expect(page.getByTestId('hotspot-treemap')).toBeVisible();
  await expect(page.getByTestId('repo-tab-hotspots')).toHaveAttribute('data-active', 'true');
  // The window filter came from the URL, not a default — assert the control
  // reflects it, otherwise a dropped search param would still "look" fine.
  await expect(page.getByTestId('filter-window')).toHaveValue('90d');
});

test('the health score never appears without its basis', async ({ page }) => {
  await loginAsFixture(page);
  const href = await (async () => {
    await page.goto('/?window=90d');
    return firstRepoHref(page);
  })();
  await page.goto(href);

  // UX_SPEC §1.4 / principle 4 "signals, not grades": a score with no basis
  // label reads as a verdict. The breakdown is behind the toggle, but the
  // toggle itself must always be there.
  await expect(page.getByTestId('health-why-toggle')).toBeVisible();
  await page.getByTestId('health-why-toggle').click();
  await expect(page.getByTestId('health-why-popover')).toBeVisible();
  await expect(page.getByTestId('health-basis')).not.toBeEmpty();
  // The breakdown must show real sub-score rows, not an empty <dl> — the
  // response shape here is an ARRAY of {key, normalized, weight, contribution},
  // and an object/array mix-up renders a silently blank popover.
  await expect(page.getByTestId('health-why-popover').locator('dt')).not.toHaveCount(0);
});

test('repo detail passes axe with real data', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');
  const href = await firstRepoHref(page);
  await page.goto(href);
  await expect(page.getByTestId('repo-pulse').locator('canvas').first()).toBeVisible();
  await expectNoA11yViolations(page);
});
