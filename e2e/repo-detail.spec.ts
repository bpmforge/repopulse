import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';
import { SEED_REPO_NAMES } from '@repopulse/shared';

// W4-04 acceptance 4: org → repo → tab by CLICKS and by DIRECT URL PASTE
// (FR-WEB-2). Both paths matter and they fail differently — clicking exercises
// the link wiring, pasting exercises route parsing and search validation on a
// cold load with no in-memory router state to fall back on.

// A SEEDED repo, by name. Every assertion here depends on fixture shape (four
// metric charts, a chart on every tab), and the ingest specs add real ingested
// repos to this same workspace which — now that they reach `live` — can render
// ahead of the seeded ones. Position is not identity.
function seededTile(page: import('@playwright/test').Page) {
  return page.getByTestId('health-tile-grid').locator('a').filter({ hasText: SEED_REPO_NAMES[0] }).first();
}

async function firstRepoHref(page: import('@playwright/test').Page): Promise<string> {
  const href = await seededTile(page).getAttribute('href');
  if (!href) throw new Error('no seeded repo link on the org overview');
  return href;
}

test('drills org → repo → each tab by clicking, breadcrumb intact', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');

  await seededTile(page).click();
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

// W16-01 (F12): the /repos LIST is its own entry point, and its rows are the
// second item in the rail. The org-overview tile above proves the layout route
// is linkable; this proves the list's own rows are, by mouse AND by keyboard —
// a component test renders the anchor happily while the click does nothing.
test('the /repos list rows navigate, by click and by keyboard', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/repos?window=90d');

  const row = page.getByTestId('repo-list').locator('a').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/repos\/\d+/);
  await expect(page.getByTestId('repo-name')).toContainText('/');

  // Keyboard activation is a separate path: a handler that swallows the click
  // can leave Enter working, and vice versa. Both were dead in the review.
  await page.goto('/repos?window=90d');
  const kbRow = page.getByTestId('repo-list').locator('a').first();
  await kbRow.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/repos\/\d+/);
  await expect(page.getByTestId('repo-name')).toContainText('/');
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

test('the CI tab shows M9 duration and the flakiest workflows (W4-15)', async ({ page }) => {
  await loginAsFixture(page);
  // A SEEDED repo by name, for the reason at the top of this file: ingested
  // repos share the workspace and can render first, and position is not identity.
  await page.goto('/?window=90d');
  await seededTile(page).click();
  await page.getByTestId('repo-tab-ci').click();

  // Both panels replaced an explanatory empty state that named W4-15. The
  // reason was real: computeCiDuration and computeCiFlakiness were implemented,
  // fixture-tested and called by nothing, so M9's snapshot row carried a single
  // scalar and there was nothing for a chart to read.
  const duration = page.getByTestId('ci-duration');
  await expect(duration).toBeVisible();
  // A real duration, not an em dash: "—" is what this renders when the value is
  // null, which is exactly the state the panel used to be stuck in.
  await expect(duration).toContainText(/\d/);
  await expect(duration).not.toHaveText(/^—/);

  const flakiest = page.getByTestId('ci-flakiest');
  await expect(flakiest).toBeVisible();
  await expect(flakiest.locator('tbody tr')).not.toHaveCount(0);
  // Ranked by rate, and the rate is a percentage — a bare ratio here would be
  // the 0-1-vs-0-100% misreading W4-13 already caught on the KPI tiles.
  await expect(flakiest.locator('tbody tr').first()).toContainText('%');
});

test('the PR Flow tab shows review load built from REVIEWER data (W4-15)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');
  await seededTile(page).click();
  await page.getByTestId('repo-tab-pr-flow').click();

  const load = page.getByTestId('review-load');
  await expect(load).toBeVisible();
  await expect(load.locator('tbody tr')).not.toHaveCount(0);

  // The exclusions are STATED. A filtered number presented as a total is the
  // failure mode this panel was held back to avoid — a matrix built from author
  // data would have rendered just as convincingly while answering a different
  // question.
  await expect(load).toContainText(/self-review/i);
  await expect(load).toContainText(/bot review/i);
  // Signals, not grades (UX_SPEC §7).
  await expect(load).toContainText(/not a ranking/i);
});

// W16-46. The Findings tab was a hardcoded teaser — "Code review findings
// arrive with Tier-2 analysis (wave W6)" — with no request behind it, long
// after W6 shipped. The tab loop above could not catch it because it asserts a
// canvas per tab and this tab has no chart, so the one screen a reader reaches
// by drilling into a repository kept telling them the feature did not exist
// while the explorer listed the very same rows.
test('the repo Findings tab lists that repo\'s findings and opens one in place', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/?window=90d');
  // The tile's href already carries the global search, so appending a child
  // path to it produces `/repos/1?window=90d/findings` — which routes to the
  // repo index and renders Pulse. Extract the id, like the deep-link test above.
  const repoId = (await firstRepoHref(page)).match(/\/repos\/(\d+)/)?.[1];
  expect(repoId).toBeDefined();

  await page.goto(`/repos/${repoId}/findings?window=90d`);
  await expect(page.getByTestId('repo-findings')).toBeVisible();

  // ROWS, not just a visible container: the teaser was "visible" too. The
  // fixture seeds three findings against the first repo.
  const rows = page.getByTestId('repo-finding-rows').locator('tr');
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('repo-findings')).toContainText(
    'SQL built by string concatenation',
  );

  // Opening one keeps the reader IN the repository — the point of putting the
  // detail panel here rather than linking out to the explorer.
  await page.getByTestId('repo-finding-rows').locator('button').first().click();
  await expect(page).toHaveURL(/finding=\d+/);
  await expect(page).toHaveURL(/\/repos\/\d+\/findings/);
  await expect(page.getByTestId('finding-detail')).toBeVisible();
  // The global filter survives opening a finding (DASHBOARD §1).
  await expect(page).toHaveURL(/window=90d/);
});
