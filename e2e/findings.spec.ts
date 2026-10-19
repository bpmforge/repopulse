import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// Findings Explorer (W6-04, UX_SPEC §4.e, FR-WEB-9).
//
// The last of four rail destinations that linked nowhere since W4-02.

test('the explorer lists seeded findings, filters, and passes axe', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/findings');

  await expect(page.getByTestId('findings')).toBeVisible();
  await expectNoA11yViolations(page);

  const rows = page.getByTestId('finding-rows').locator('tr');
  await expect(rows.first()).toBeVisible();

  // Severity ordering: the critical SQL finding outranks the empty catch.
  await expect(rows.first()).toContainText(/critical/i);

  // Filtering narrows server-side, not in the browser.
  await page.getByTestId('filter-dimension').selectOption('code_health');
  await expect.poll(async () => (await rows.allInnerTexts()).join(' ')).toMatch(/Empty catch/i);
  await expect(page.getByTestId('finding-rows')).not.toContainText(/SQL built/i);
});

test('filter → open → acknowledge, with the note the API insists on', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/findings');

  // Status filter to "Any" FIRST. The explorer defaults to open findings, so
  // confirming one removes it from the filtered list and unmounts the detail
  // panel with it — correct behaviour, but it makes the post-transition
  // history unobservable. (Worth revisiting as a UX question: someone reading
  // a finding probably expects the panel to survive their own triage.)
  await page.getByTestId('filter-status').selectOption('');

  const open = page.locator('[data-testid^="finding-open-"]').first();
  await expect(open).toBeVisible();
  const id = (await open.getAttribute('data-testid'))!.replace('finding-open-', '');
  await open.click();

  await expect(page.getByTestId('finding-detail')).toBeVisible();
  // The evidence quote is what makes a finding believable — it is validated to
  // be verbatim from the reviewed diff (W6-02).
  await expect(page.getByTestId('finding-detail')).toContainText(
    /select \* from charges|catch|db\./,
  );

  // W19-10: a finding no AI pass has looked at says so; it never reads as
  // "reviewed and fine".
  await expect(page.getByTestId('ai-section')).toBeVisible();
  await expect(page.getByTestId('ai-not-run')).toContainText(/Not yet run/);

  // A status change with no note must be impossible from the UI, because the
  // API refuses it: "why was this closed?" is the first question anyone asks
  // about a finding that later turned out to matter.
  await expect(page.getByTestId('finding-confirm')).toBeDisabled();

  await page.getByTestId('finding-note').fill('Reviewed with the payments team.');
  await page.getByTestId('finding-confirm').click();

  // The transition shows up in the history NAMED, which distinguishes it both
  // from an automatic one and — since W16-59 made a removed account null the
  // actor id — from a person whose account has since gone. The login is stored
  // beside the id at write time precisely so the name outlives the account.
  await expect(page.getByTestId('finding-history')).toContainText(/confirmed/);
  await expect(page.getByTestId('finding-history')).toContainText(/fixture-dev/);
  await expect(page.getByTestId('finding-history')).not.toContainText(/automatic/);
  await expect(page.getByTestId(`finding-${id}`)).toContainText(/confirmed/);
});

test('bulk triage applies to a selection and refuses without a note', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/findings');

  // Row boxes only: since W20-03 the header has a select-the-page box too.
  const boxes = page.locator(
    '[data-testid^="finding-select-"]:not([data-testid="finding-select-page"])',
  );
  await boxes.nth(0).check();
  await expect(page.getByTestId('bulk-bar')).toBeVisible();
  await expect(page.getByTestId('bulk-dismissed')).toBeDisabled();

  await page.getByTestId('bulk-note').fill('Triaged in the weekly review.');
  // W20-03 (FND-11): a bulk dismissal needs a reason too.
  await expect(page.getByTestId('bulk-dismissed')).toBeDisabled();
  await page.getByTestId('bulk-dismiss-reason').selectOption('not_applicable');
  await expect(page.getByTestId('bulk-dismissed')).toBeEnabled();
});

test('the verification facet separates confirmed, unverified and contradicted (W6-05)', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/findings');
  await page.getByTestId('filter-status').selectOption('');

  // A finding a second model confirmed carries a badge that says so — and one
  // nobody re-judged says THAT, rather than nothing.
  await expect(page.getByTestId('finding-rows')).toContainText(/verified by a second model/i);

  await page.getByTestId('filter-verify').selectOption('contradicted');
  await expect
    .poll(async () => (await page.getByTestId('finding-rows').allInnerTexts()).join(' '))
    .toMatch(/contradicted on review/i);
  // A contradicted finding must not still claim to be verified.
  await expect(page.getByTestId('finding-rows')).not.toContainText(/verified by a second model/i);
});

test('the triage queue steps with the keyboard and reports its own FP count (W6-06)', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/findings');
  await page.getByTestId('filter-status').selectOption('');
  await expect(page.getByTestId('main')).toBeVisible();

  await page.getByTestId('start-triage').click();
  await expect(page.getByTestId('triage-queue')).toBeVisible();
  await expectNoA11yViolations(page);

  const position = page.getByTestId('triage-position');
  await expect(position).toContainText(/1 of/);

  // j/k move without a mouse — triaging forty findings by clicking is a job
  // nobody finishes (NFR-5).
  await page.keyboard.press('j');
  await expect(position).toContainText(/2 of/);
  await page.keyboard.press('k');
  await expect(position).toContainText(/1 of/);

  // W20-03 (FND-08): the note starts empty and a dismissal needs a reason —
  // 1 picks false positive. Then d dismisses and advances; the summary counts
  // it, feeding the same false-positive metric the quality widget reads.
  await page.getByTestId('triage-note').fill('Fixture code, not shipped.');
  await page.getByTestId('triage-note').blur();
  await page.keyboard.press('1');
  await page.keyboard.press('d');
  await expect(page.getByTestId('triage-summary')).toContainText(
    /1 dismissed \(1 as false positive\)/,
  );

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('triage-queue')).toHaveCount(0);
});

test('the weekly pulse card is computed, and says so (W6-06, R-A7/R-D3)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('pulse-card')).toBeVisible();

  // Exactly five bullets, always — a summary whose shape changes week to week
  // cannot be skimmed.
  await expect(page.getByTestId('pulse-card').locator('li')).toHaveCount(5);

  // Provenance is honest: a template wrote this, and the chip must not imply a
  // model did.
  await expect(page.getByTestId('pulse-provenance')).toContainText(/computed from your warehouse/i);
});

test('a finding can be LINKED to: opening one puts it in the URL (W16-16)', async ({ page }) => {
  // For a triage tool the workflow is "look at this one" — and there was no
  // way to send someone that one. The open row lived in component state, so a
  // pasted URL always landed on the list. FR-WEB-2 already requires a pasted
  // URL to restore the identical screen.
  await loginAsFixture(page);
  // WITH A GLOBAL FILTER SET. This is the first child route in the app to
  // declare its own validateSearch, and whether ?window= survives a navigate
  // that adds ?finding= depends on the parent's search being merged rather
  // than replaced. Opening a finding must not silently reset the window and
  // repo pickers (DASHBOARD §1).
  await page.goto('/findings?window=90d');

  const open = page.locator('[data-testid^="finding-open-"]').first();
  await expect(open).toBeVisible();
  const id = (await open.getAttribute('data-testid'))!.replace('finding-open-', '');
  // The file:line cell identifies the row inside the panel, which renders the
  // title in its frame heading rather than in the panel body. nth(3) because
  // the title cell is a <th> (a row header) and not counted among the <td>s.
  const where = (await open.locator('xpath=../..').locator('td').nth(3).textContent())!.trim();
  await open.click();

  await expect(page.getByTestId('finding-detail')).toBeVisible();
  // The URL now carries it — that is the whole feature.
  await expect(page).toHaveURL(new RegExp(`[?&]finding=${id}\\b`));
  // ...and the global filter is still there IN THE URL, which is what makes the
  // link carry it to the recipient. The window CONTROL is deliberately not
  // rendered on this screen (W16-50): findings have no time dimension, and a
  // window here would quietly hide the oldest findings — the ones that matter
  // most. The value rides along regardless, so a screen that does apply it
  // still gets it.
  await expect(page).toHaveURL(/[?&]window=90d\b/);
  await expect(page.getByLabel('Time window')).toHaveCount(0);
  const link = page.url();

  // COLD. A fresh context is what the recipient of the link has: no click
  // history, no in-memory state, only the URL.
  await page.context().clearCookies();
  await loginAsFixture(page);
  await page.goto(link);
  await expect(page.getByTestId('finding-detail')).toBeVisible();
  // The SAME finding, not merely a panel: the file:line the row showed.
  await expect(page.getByTestId('finding-detail')).toContainText(where.split(':')[0]!);
  await expect(page.getByTestId('finding-not-in-view')).toBeHidden();

  // Closing takes it back out, so a shared link is never stale for the sender.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('finding-detail')).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]finding=/);
  // Closing removes the finding and nothing else.
  await expect(page).toHaveURL(/[?&]window=90d\b/);
});

test('a link opens a finding the filters HIDE (W16-32)', async ({ page }) => {
  // W16-16 put the finding in the URL; the filters are still component state,
  // so a link resolved against the RECIPIENT'S view. A triage tool whose "look
  // at this one" link depends on what the reader happens to be filtering by is
  // not a link. GET /findings/:id is what makes it one.
  await loginAsFixture(page);
  await page.goto('/findings');

  // Dismiss one, so it leaves the default (status = open) list.
  await page.getByTestId('filter-status').selectOption('');
  const open = page.locator('[data-testid^="finding-open-"]').first();
  await expect(open).toBeVisible();
  const id = (await open.getAttribute('data-testid'))!.replace('finding-open-', '');
  await open.click();
  await expect(page.getByTestId('finding-detail')).toBeVisible();
  await page.getByTestId('finding-note').fill('W16-32 link fixture');
  await page.getByTestId('finding-dismiss-reason').selectOption('false positive');
  await page.getByTestId('finding-dismiss').click();
  // Dismissed rows leave the default list, which is the whole point of the
  // fixture — wait for the transition before sharing the link.
  await expect(page.getByTestId('finding-detail')).toContainText(/dismissed/i);

  // COLD, with the DEFAULT filters — which exclude a dismissed finding.
  await page.context().clearCookies();
  await loginAsFixture(page);
  await page.goto(`/findings?finding=${id}`);

  // Fetched by id rather than found in the list. Before W16-32 this was the
  // "not in the current view" notice.
  await expect(page.getByTestId('finding-detail')).toBeVisible();
  await expect(page.getByTestId('finding-not-in-view')).toBeHidden();
  // AND THE LIST DOES NOT HOLD IT — otherwise this passes through the old path
  // and proves nothing about the by-id fetch.
  await expect(page.getByTestId(`finding-open-${id}`)).toBeHidden();
  await expect(page.getByTestId('finding-detail')).toContainText(/dismissed/i);
});

test('a finding opens in the forge, at a real URL (W16-41)', async ({ page }) => {
  // The detail panel rendered `src/service.ts:15–18` as PLAIN TEXT, so on a
  // triage tool whose whole workflow is "look at this one", the step after
  // reading a finding was to go and find the file by hand.
  await loginAsFixture(page);
  await page.goto('/findings');
  await page.locator('[data-testid^="finding-open-"]').first().click();
  await expect(page.getByTestId('finding-detail')).toBeVisible();

  const link = page.getByTestId('finding-forge-link');
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  // The SHAPE, not a fixed string: the instance and repo come from the seeded
  // connection. What must hold is that it is an absolute URL into a file, with
  // the line anchor — a link to the repository root would pass a "has an href"
  // assertion and be useless.
  expect(href).toMatch(/^https?:\/\/.+\/blob\/.+\/.+\.[a-z]+#L\d+/);
  // Opens away from the app, so triage does not lose its place.
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noreferrer/);
});

test('a link to a finding that does not exist SAYS so, rather than nothing (W16-16)', async ({
  page,
}) => {
  // Landing silently on the list is indistinguishable from a broken link — the
  // failure this whole screen's copy is careful about. Reaching this state now
  // means the id genuinely is not in the workspace, because W16-32's by-id
  // fetch covers the filtered case.
  await loginAsFixture(page);
  await page.goto('/findings?finding=999999999');

  const notice = page.getByTestId('finding-not-in-view');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('999999999');
  await expect(notice).toContainText(/not in this workspace/i);
});
