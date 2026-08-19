import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// Report Center + PDF pipeline (W5-04, REPORTS.md §6, FR-REPORTS-1/6).
//
// pdf-parse is named in the acceptance for asserting text inside the PDF, but
// it is not in TECH_STACK.md and was not added (parked for Brad). What is
// asserted instead: a real %PDF artifact of non-trivial size served through the
// session check, and the section headings + basis text in the PRINT ROUTE DOM
// that the PDF is rendered from — which is where a missing section would
// actually originate.

test('generate → ready → download a real PDF (FR-REPORTS-6)', async ({ page, context }) => {
  await loginAsFixture(page);
  await page.goto('/reports');

  await expect(page.getByTestId('generate-form')).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByTestId('report-type').selectOption('repo_health');
  await page.getByTestId('generate-report').click();

  // The row appears immediately as queued — the history table is how anyone
  // learns generation finished, so it has to show the job before it is done.
  const firstRow = page.locator('[data-testid^="report-status-"]').first();
  await expect(firstRow).toBeVisible();

  // Printing launches a real headless browser in the worker; 30s is the
  // REPORTS.md §3 budget, so the poll is allowed slightly more than that.
  await expect(firstRow).toContainText(/ready/, { timeout: 45_000 });

  const downloadLink = page.locator('[data-testid^="report-download-"]').first();
  await expect(downloadLink).toBeVisible();
  const href = await downloadLink.getAttribute('href');

  // Fetched through the API with the session, exactly as the browser would:
  // artifacts are never on a public path (REPORTS.md §4).
  const res = await context.request.get(href as string);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  const body = await res.body();
  expect(body.subarray(0, 4).toString()).toBe('%PDF');
  // A PDF that is merely valid can still be an empty page; a real one with a
  // cover, basis box and appendix is comfortably over 5KB.
  expect(body.byteLength).toBeGreaterThan(5000);
});

test('the print route renders stored data with its basis and appendix', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/reports');
  await page.getByTestId('generate-report').click();
  await expect(page.locator('[data-testid^="report-status-"]').first()).toContainText(/ready/, {
    timeout: 45_000,
  });

  await page.locator('[data-testid^="report-view-"]').first().click();
  await expect(page.getByTestId('print-report')).toBeVisible();

  // The sections the PDF is built from. Asserted here rather than in the PDF
  // bytes because this is where a missing section would originate.
  await expect(page.getByTestId('print-title')).toBeVisible();
  await expect(page.getByTestId('print-basis')).toContainText(/computed at or before/i);
  await expect(page.getByTestId('print-appendix')).toContainText(/metric definitions/i);

  // No app chrome in a printed page — the rail would otherwise be in the PDF.
  await expect(page.getByTestId('rail-repos')).toHaveCount(0);
});

test('downloading a report that is not ready is refused, not a broken file', async ({
  page,
  context,
}) => {
  await loginAsFixture(page);
  // An id that cannot exist in this workspace: a 404 rather than a 403, since
  // a 403 would confirm the id exists somewhere (Law 5).
  const res = await context.request.get('/api/v1/reports/999999/download');
  expect(res.status()).toBe(404);
});

test('two reports of the same scope diff, and an annotation reaches the cover (W5-09)', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/reports');

  // Two generations of the SAME scope, the second annotated.
  //
  // The baseline is taken BEFORE the first generate, and every wait counts from
  // it. Taking it in between let the FIRST generation's row satisfy the count
  // assertion meant for the second, so `.first()` was the unannotated report
  // and the annotation check failed on a report that never had one — a race
  // invisible when this file runs alone and reliable once earlier tests have
  // already put reports in the list.
  const rows = page.locator('[data-testid^="report-status-"]');
  const before = await rows.count();

  await page.getByTestId('generate-report').click();
  await expect(rows).toHaveCount(before + 1, { timeout: 15_000 });
  await expect(rows.first()).toContainText(/ready/, { timeout: 45_000 });

  await page.getByTestId('report-annotation').fill('Quarter includes the payments migration');
  await page.getByTestId('generate-report').click();

  // Wait for the NEW row to appear before asserting on the first one. The
  // history polls every 3s, so immediately after clicking Generate the first
  // row is still the PREVIOUS report — which is already ready, so a status
  // assertion passes against the wrong report and the annotation check then
  // fails on a report that never had one.
  await expect(rows).toHaveCount(before + 2, { timeout: 15_000 });
  await expect(rows.first()).toContainText(/ready/, { timeout: 45_000 });

  // The annotation is on the cover of the report it was captured with — and
  // immutability means it could not have been added to the earlier one.
  await page.locator('[data-testid^="report-view-"]').first().click();
  await expect(page.getByTestId('print-annotation')).toContainText(/payments migration/);

  // Navigate back EXPLICITLY and wait for both rows before touching the
  // checkboxes. page.goBack() returned to a Report Center whose list had not
  // repopulated, so the compare boxes were operated on a half-rendered table
  // and the diff panel never mounted — which read as "the diff is broken" when
  // an identical sequence with an explicit wait renders it fine.
  await page.goto('/reports');
  const readyRows = page.locator('[data-testid^="report-compare-"]');
  await expect(readyRows).toHaveCount(before + 2);

  await readyRows.nth(0).check();
  await readyRows.nth(1).check();

  // Same type, same scope, same window → comparable, with real rows.
  await expect(page.getByTestId('diff-table')).toBeVisible();
  await expect(page.getByTestId('diff-table').locator('tbody tr').first()).toBeVisible();
});
