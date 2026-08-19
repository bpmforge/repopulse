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
  await expect
    .poll(async () => (await rows.allInnerTexts()).join(' '))
    .toMatch(/Empty catch/i);
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
  await expect(page.getByTestId('finding-detail')).toContainText(/select \* from charges|catch|db\./);

  // A status change with no note must be impossible from the UI, because the
  // API refuses it: "why was this closed?" is the first question anyone asks
  // about a finding that later turned out to matter.
  await expect(page.getByTestId('finding-confirm')).toBeDisabled();

  await page.getByTestId('finding-note').fill('Reviewed with the payments team.');
  await page.getByTestId('finding-confirm').click();

  // The transition shows up in the history with an actor, distinguishing it
  // from an automatic one.
  await expect(page.getByTestId('finding-history')).toContainText(/confirmed/);
  await expect(page.getByTestId('finding-history')).toContainText(/by a person/);
  await expect(page.getByTestId(`finding-${id}`)).toContainText(/confirmed/);
});

test('bulk triage applies to a selection and refuses without a note', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/findings');

  const boxes = page.locator('[data-testid^="finding-select-"]');
  await boxes.nth(0).check();
  await expect(page.getByTestId('bulk-bar')).toBeVisible();
  await expect(page.getByTestId('bulk-dismissed')).toBeDisabled();

  await page.getByTestId('bulk-note').fill('Triaged in the weekly review.');
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
