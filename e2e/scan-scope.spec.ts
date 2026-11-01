import { expect, test, type Page } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';
import { SEED_REPO_NAMES } from '@repopulse/shared';

// Scan scope on the Security tab (W23-08; W23-01 skip, W23-03 incremental).
//
// What this proves: pressing "Run scans now" twice with no new commit between
// the presses re-scans nothing the second time, and the coverage table says so
// ("up to date as of <date>") instead of reading as a fresh scan.
//
// HOW "NO TARBALL TRAFFIC" IS ASSERTED. The fake forge lives inside the e2e API
// process (e2e/server.ts), so a spec cannot read its request log. What the spec
// CAN read is the thing that decides whether a tarball is fetched at all: the
// scan processor asks "is this scanner up to date?" BEFORE it calls the runner,
// and the runner's first act is the archive fetch (apps/api/src/workers/
// scan-processor.ts, W23-01; the processor-level test there counts the fetches).
// So a run recorded with scope `skipped` is, by construction, a run that made no
// archive request. The spec therefore asserts, for every scanner that had a
// successful baseline: (1) the press's own response lists it under `up_to_date`
// and not under `started`; (2) every scan_runs row it wrote since the second
// press has scope `skipped` — none `full` or `incremental`; (3) the table shows
// "up to date as of". A regression that re-fetched would record a full run and
// fail (1) and (2).
//
// Needs the seeded e2e stack with the scan worker, like code-health.spec.ts.
// It cannot run offline: run it on the Mac (`pnpm exec playwright test
// e2e/scan-scope.spec.ts`).

interface ScanRun {
  id: number;
  scanner_key: string;
  status: string;
  scope?: string;
}
interface ScannerRow {
  key: string;
  registered: boolean;
  enabled: boolean;
  state: string;
  last_run_at: string | null;
}
interface PressResult {
  started: string[];
  already_running: string[];
  up_to_date?: string[];
}

const TERMINAL = (r: ScanRun) => r.status !== 'running' && r.status !== 'queued';

async function openSecurityTab(page: Page): Promise<string> {
  await page.goto('/?window=90d');
  await page
    .getByTestId('health-tile-grid')
    .locator('a')
    .filter({ hasText: SEED_REPO_NAMES[0] as string })
    .first()
    .click();
  await expect(page).toHaveURL(/\/repos\/\d+/);
  const repoId = /\/repos\/(\d+)/.exec(page.url())?.[1] as string;
  await page.getByTestId('repo-tabs').getByRole('link', { name: 'Security' }).click();
  await expect(page.getByTestId('scanner-status')).toBeVisible();
  return repoId;
}

/** Every run this repository has (newest 50), from the API — not from a screen. */
async function runsOf(page: Page, repoId: string): Promise<ScanRun[]> {
  const since = encodeURIComponent(new Date(0).toISOString());
  const res = await page.request.get(`/api/v1/repos/${repoId}/scan-runs?since=${since}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { runs: ScanRun[] }).runs;
}
const newestId = (runs: ScanRun[]) => runs.reduce((max, r) => Math.max(max, r.id), 0);

async function scannersOf(page: Page, repoId: string): Promise<ScannerRow[]> {
  const res = await page.request.get(`/api/v1/repos/${repoId}/security`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { scanners: ScannerRow[] }).scanners;
}

/** Press "Run scans now" and return what the API answered. */
async function press(page: Page, repoId: string): Promise<PressResult> {
  const answered = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname.endsWith(`/repos/${repoId}/scan`),
  );
  await page.getByTestId('run-scan-button').click();
  const res = await answered;
  expect(res.status()).toBe(202);
  return (await res.json()) as PressResult;
}

/**
 * Wait until the press has settled: the page's own button unlocks (it derives
 * that from the coverage table, W17-20) and every run newer than `after` is in
 * a terminal state, with at least `min` of them present.
 */
async function settle(page: Page, repoId: string, after: number, min: number): Promise<ScanRun[]> {
  await expect
    .poll(
      async () => {
        const fresh = (await runsOf(page, repoId)).filter((r) => r.id > after);
        return fresh.length >= min && fresh.every(TERMINAL);
      },
      { timeout: 120_000, intervals: [1_000, 2_000], message: 'the press settled' },
    )
    .toBe(true);
  await expect(page.getByTestId('run-scan-button')).toHaveText('Run scans now', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('run-scan-button')).toBeEnabled();
  return (await runsOf(page, repoId)).filter((r) => r.id > after);
}

test.describe('scan scope', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let repoId = '';
  let okKeys: string[] = [];

  test('a second "Run scans now" with no new commit re-scans nothing and says "up to date"', async ({
    page,
  }) => {
    await loginAsFixture(page);
    repoId = await openSecurityTab(page);
    await expect(page.getByTestId('run-scan-button')).toBeEnabled();

    // PRESS ONE — establishes a baseline (or finds one from an earlier run of
    // this spec, in which case it too is answered by `skipped` rows).
    const base0 = newestId(await runsOf(page, repoId));
    const first = await press(page, repoId);
    expect(first.started.length + (first.up_to_date ?? []).length).toBeGreaterThan(0);
    await settle(page, repoId, base0, 1);

    // The scanners that completed a successful run are the ones the second
    // press is allowed — and required — to leave alone. Failed ones (a scanner
    // whose tooling is missing in this stack) legitimately retry.
    okKeys = (await scannersOf(page, repoId))
      .filter((s) => s.registered && s.enabled && s.state === 'ok' && s.last_run_at)
      .map((s) => s.key);
    expect(
      okKeys.length,
      'at least one scanner must have a successful run to be "up to date" — is the scan worker running?',
    ).toBeGreaterThan(0);

    // PRESS TWO — same commit: no sync, no push, nothing between the presses.
    const base1 = newestId(await runsOf(page, repoId));
    const second = await press(page, repoId);
    for (const key of okKeys) {
      expect(second.up_to_date ?? [], `${key} listed as up to date`).toContain(key);
      expect(second.started, `${key} not started`).not.toContain(key);
    }
    const fresh = await settle(page, repoId, base1, okKeys.length);

    for (const key of okKeys) {
      const rows = fresh.filter((r) => r.scanner_key === key);
      expect(rows.length, `${key} recorded a run for the second press`).toBeGreaterThan(0);
      // `skipped` is written before the runner — so before any archive fetch.
      expect(
        rows.map((r) => r.scope),
        `${key}: the second press recorded only skipped runs (no tarball fetch)`,
      ).toEqual(rows.map(() => 'skipped'));
    }

    // The table: Up-to-date rows, said in words, with the last-full tooltip.
    await page.reload();
    for (const key of okKeys) {
      await expect(page.getByTestId(`scanner-scope-${key}`)).toContainText(/^up to date as of /i);
      await expect(page.getByTestId(`scanner-state-${key}`)).toContainText(/up to date/i);
      await expect(page.getByTestId(`scanner-last-full-${key}`)).toContainText(
        /Last full scan:|No full scan on record/,
      );
    }
    await expectNoA11yViolations(page);
  });

  test('"Full rescan" in the table re-scans that one scanner even though nothing changed', async ({
    page,
  }) => {
    expect(okKeys.length, 'the first test establishes the baseline').toBeGreaterThan(0);
    await loginAsFixture(page);
    await page.goto(`/repos/${repoId}/security`);
    await expect(page.getByTestId('scanner-status')).toBeVisible();

    const key = okKeys.includes('secrets') ? 'secrets' : (okKeys[0] as string);
    const control = page.getByRole('button', { name: new RegExp(`^Full rescan: `) });
    const mine = page.getByTestId(`scanner-full-rescan-${key}`);
    await expect(mine, 'an up-to-date row offers Full rescan (admin)').toBeVisible();
    await expect(control.first()).toBeVisible();

    const base = newestId(await runsOf(page, repoId));
    const answered = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.endsWith(`/repos/${repoId}/scan`),
    );
    await mine.click();
    const res = await answered;
    expect(res.request().postDataJSON()).toEqual({ scanner_key: key, force: true });
    expect(((await res.json()) as PressResult).started).toContain(key);

    await expect
      .poll(
        async () =>
          (await runsOf(page, repoId)).filter(
            (r) => r.id > base && r.scanner_key === key && TERMINAL(r),
          ),
        { timeout: 120_000, intervals: [1_000, 2_000] },
      )
      .not.toHaveLength(0);
    const rows = (await runsOf(page, repoId)).filter((r) => r.id > base && r.scanner_key === key);
    expect(
      rows.every((r) => r.scope === 'full'),
      'a forced run reads the whole tree',
    ).toBe(true);

    await page.reload();
    await expect(page.getByTestId(`scanner-scope-${key}`)).toContainText(/^full/);
  });
});
