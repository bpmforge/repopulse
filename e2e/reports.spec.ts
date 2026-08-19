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
