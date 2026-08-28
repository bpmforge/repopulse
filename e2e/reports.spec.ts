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
  context,
}) => {
  await loginAsFixture(page);

  // Reports are created through the API so the test HOLDS THEIR IDS, then the
  // UI is driven by those ids. The previous version identified reports by list
  // position (.first()) in a list other tests add to and that refetches every
  // three seconds — three separate races were fixed and it still failed inside
  // the full file, because position is not a stable identifier here.
  const create = async (annotation?: string): Promise<number> => {
    const res = await context.request.post('/api/v1/reports', {
      headers: { 'x-requested-with': 'repopulse' },
      data: { type: 'repo_health', window_days: 30, ...(annotation ? { annotation } : {}) },
    });
    expect(res.status()).toBe(201);
    return ((await res.json()) as { id: number }).id;
  };

  const waitReady = async (id: number): Promise<void> => {
    await expect
      .poll(
        async () => {
          const r = await context.request.get(`/api/v1/reports/${id}`);
          return ((await r.json()) as { status: string }).status;
        },
        { timeout: 60_000, message: `report ${id} never became ready` },
      )
      .toBe('ready');
  };

  const first = await create();
  const second = await create('Quarter includes the payments migration');
  await waitReady(first);
  await waitReady(second);

  // The annotation is on the cover of the report it was captured with — and
  // because reports are immutable, it could not have been added to the earlier
  // one. Navigated by id, so it cannot land on the wrong report.
  await page.goto(`/print/reports/${second}`);
  await expect(page.getByTestId('print-annotation')).toContainText(/payments migration/);

  await page.goto(`/print/reports/${first}`);
  await expect(page.getByTestId('print-report')).toBeVisible();
  await expect(page.getByTestId('print-annotation')).toHaveCount(0);

  // Same type, same scope, same window → comparable, with real rows.
  await page.goto('/reports');
  await page.getByTestId(`report-compare-${first}`).check();
  await page.getByTestId(`report-compare-${second}`).check();

  await expect(page.getByTestId('diff-table')).toBeVisible();
  await expect(page.getByTestId('diff-table').locator('tbody tr').first()).toBeVisible();
});

test('a report finishing in a BACKGROUNDED tab still reaches ready (W16-12)', async ({ page }) => {
  // TanStack Query pauses `refetchInterval` while the document is hidden
  // (`refetchIntervalInBackground` defaults false), and the Report Center
  // relies on that poll for queued → running → ready. So the question this
  // test exists to answer: does a report you started, then switched away from,
  // ever show as finished?
  //
  // The 2026-08-27 walk said no — report 1177 finished server-side at 20:50:35
  // and the row still read "running" ~50s later, with two GETs in a window
  // that should have held sixteen.
  test.setTimeout(120_000);

  await loginAsFixture(page);
  await page.goto('/reports');
  await expect(page.getByTestId('generate-form')).toBeVisible();

  // The rows that are ALREADY here. Without this the test watches
  // `.first()`, which after the specs above is a report that finished minutes
  // ago — it passed in 161ms for exactly that reason, proving nothing.
  const idsOf = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="report-status-"]')].map(
        (el) => el.getAttribute('data-testid')!,
      ),
    );
  const before = new Set(await idsOf());

  // BACKGROUND IT FIRST, so the WHOLE lifecycle happens hidden.
  //
  // Not by opening a second tab: Playwright's headless pages all report
  // `visibilityState: 'visible'`, so `bringToFront()` proves nothing (the
  // first version of this test asserted 'hidden' and failed on that line).
  //
  // The SIGNAL is emulated instead, because the signal is the whole mechanism:
  // focusManager subscribes to `visibilitychange` and reads
  // `document.visibilityState`, and that reading is the only thing that pauses
  // a refetchInterval. This puts the app in exactly the state a backgrounded
  // tab puts it in, which is what is under test rather than Chromium's tab
  // bookkeeping.
  //
  // Backgrounding BEFORE the click also removes the race in the obvious
  // ordering: background afterwards and a fast generation can finish inside
  // the first still-visible tick, passing without ever exercising this path.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');

  await page.getByTestId('generate-report').click();

  // The NEW row appears without help, because the mutation invalidates the
  // list and an invalidate refetches regardless of visibility. Reaching READY
  // is the part that needs the interval.
  const newId = await expect
    .poll(async () => (await idsOf()).find((id) => !before.has(id)), { timeout: 15_000 })
    .not.toBeUndefined()
    .then(async () => (await idsOf()).find((id) => !before.has(id))!);

  // Read the DOM WITHOUT touching the page: Playwright can query a hidden
  // document, and any click, focus or bringToFront here would trigger the
  // refetch-on-focus that hides the bug.
  await expect(page.getByTestId(newId.replace('report-status-', 'report-status-'))).toContainText(
    /ready/,
    { timeout: 90_000 },
  );
});

test('the poll STOPS once every report has settled (W16-12)', async ({ page }) => {
  // The other half of the fix, and the reason `refetchIntervalInBackground`
  // is safe to leave on: the interval returns false when nothing is queued or
  // running. Without this the screen asks for the list every three seconds for
  // the life of the tab — now from a hidden one too, which is a background
  // request nobody asked for rather than a poll.
  test.setTimeout(60_000);

  await loginAsFixture(page);
  await page.goto('/reports');
  await expect(page.getByTestId('generate-form')).toBeVisible();

  // Settle everything first: earlier specs in this file leave ready rows, and
  // a generation still in flight would legitimately keep the poll alive.
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="report-status-"]')].every(
            (el) => !/queued|running/.test(el.textContent ?? ''),
          ),
        ),
      { timeout: 45_000 },
    )
    .toBe(true);

  let listRequests = 0;
  await page.route('**/api/v1/reports*', async (route) => {
    if (route.request().method() === 'GET') listRequests += 1;
    await route.continue();
  });

  // A beat, then reset: the settling loop above may have a refetch already in
  // flight when the interception goes on, and counting that would be counting
  // the setup rather than the behaviour.
  await page.waitForTimeout(1_000);
  listRequests = 0;

  // Four poll periods. A running 3s interval lands three or four GETs; the
  // fixed screen lands none from the interval.
  await page.waitForTimeout(12_000);

  // NOT `toBe(0)`, and the reason is not "it was flaky" — it is that zero is
  // the wrong claim. TanStack also refetches on window focus (deliberate, and
  // nothing to do with the interval), and in a full suite run the page can
  // take a focus event mid-wait; the first version of this asserted zero and
  // saw exactly one, alone in a 12-second window. One request is not a poll.
  // Fewer than three still fails the flat 3000ms interval this replaced.
  expect(listRequests, 'the list is still being POLLED after everything settled').toBeLessThan(3);
});
