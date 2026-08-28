import { expect, test } from '@playwright/test';

// The README quickstart, walked (W16-14).
//
// `DEMO_MODE=1 pnpm dev`, open the app, sign in through the FORM, land on a
// populated screen. Every assertion here is something the README promises in
// so many words, so this project fails when the quickstart stops working
// rather than when an implementation detail moves.
//
// It is deliberately not a tour of the product — the main e2e suite covers the
// screens. What has never been covered is the boot: three demo-mode bugs
// shipped in one wave (W16-28/29/30) because nothing anywhere started
// apps/api/src/demo.ts.

const DEMO_EMAIL = 'demo@repopulse.local';

/**
 * Sign in the way the README says to, and get past the first thing that
 * happens afterwards.
 *
 * The persona picker opens over the org overview on every first login, and the
 * demo reseeds `persona: null` on every boot — so it is not an edge case here,
 * it is the second screen of the quickstart. W16-26 added the way past it and
 * W16-26's follow-up made that survive a reload; this walks both.
 */
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const picker = page.getByTestId('persona-picker');
  await expect(picker).toBeVisible();
  await page.getByTestId('persona-defer').click();
  await expect(picker).toBeHidden();
}

/** Repo links carry the health score in their accessible name, by design. */
const repoLink = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('link', { name: new RegExp(`^${name} health score`) });

test.describe('the quickstart a newcomer follows', () => {
  test('signs in through the form and lands on a populated org overview', async ({ page }) => {
    await page.goto('/');

    // "the sign-in screen fills them in for you and says so" — README.
    const email = page.getByLabel('Email');
    await expect(email).toHaveValue(DEMO_EMAIL);
    await expect(page.getByLabel('Password')).not.toHaveValue('');
    // And it says WHY, so nobody wonders whose credentials these are.
    await expect(page.getByText(/demo mode/i).first()).toBeVisible();

    // Through the FORM. The main suite authenticates through the mocked OAuth
    // boundary with a storageState, which is why this path had no coverage.
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The picker is the SECOND screen of the quickstart, not an edge case: the
    // demo reseeds persona: null on every boot, so it opens every time. It
    // must offer a way past itself (W16-26) — being unable to dismiss it is
    // being unable to reach the product.
    await expect(page.getByTestId('persona-picker')).toBeVisible();
    await page.getByTestId('persona-defer').click();
    await expect(page.getByTestId('persona-picker')).toBeHidden();

    // POPULATED, not merely rendered. A demo whose screens are all empty
    // states is indistinguishable from a broken install, which is the failure
    // demo mode exists to prevent.
    await expect(page.getByText(/Delivery KPIs/i)).toBeVisible();
    await expect(page.getByTestId('demo-banner')).toBeVisible();
  });

  test('the seeded warehouse is actually there, on the screens it feeds', async ({ page }) => {
    await signIn(page);

    // Three seeded repos, each with a health score — the first drill-down the
    // dashboard offers.
    await page.goto('/repos');
    for (const name of ['payments', 'web-app', 'infra']) {
      await expect(repoLink(page, name)).toBeVisible();
    }

    // And the PR list, which is what W16-27's impossible stale count was about:
    // the numbers on screen have to be answerable from the rows underneath.
    await page.goto('/pull-requests');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test('the demo account is a committer, so My Focus is not empty (W16-13)', async ({ page }) => {
    // Introduced by W16-02: the demo's local account had no forge identity, so
    // resolveUserIdentity returned null, every personal view was honestly
    // empty and the shell showed the unlinked-identity banner. Correct
    // behaviour, and the wrong thing for a demo — whose whole job is to leave
    // nothing empty.
    //
    // Its OWN identity, not the fixture's: users.forge_user_id is UNIQUE, and
    // the README advertises both sign-in doors, so sharing one would give the
    // empty screen to whichever door lost it.
    await signIn(page);

    // The banner that says "we do not know which committer you are" is gone.
    await expect(page.getByTestId('forge-link-banner')).toBeHidden();

    await page.goto('/me');
    await expect(page.getByText(/My Focus|My PRs/i).first()).toBeVisible();
    // POPULATED. An empty My Focus is exactly what this ticket was.
    await expect(page.getByTestId('my-focus')).not.toContainText(/nothing to show|no open pull/i);
  });

  test('the demo forge is reachable from the WORKER, not just the API', async ({ page }) => {
    // W16-28/29/30 in one walk, read through the SCREEN rather than the log —
    // because the screen is what said "has never run" while all three were
    // happening.
    //
    //   the scanner registry had no production caller, so every row read
    //   "(not in this build)" and no scan_run could record a version
    //
    //   the fake forge runs inside the API process and the worker is a
    //   separate one, so with no FORGE_BASE_URL it sent the demo's fake
    //   credential to the REAL api.github.com and got a 401
    //
    //   the fake served no archive endpoint, so every snapshot scanner 404ed
    //
    // A scan takes real seconds: opengrep and the code-health tools run in a
    // sandbox over an extracted tree.
    test.setTimeout(180_000);

    await signIn(page);
    await page.goto('/repos');
    await repoLink(page, 'payments').click();
    await page.getByTestId('repo-tabs').getByRole('link', { name: 'Security' }).click();

    const coverage = page.getByTestId('scanner-status');
    await expect(coverage).toBeVisible();

    // REGISTERED (W16-28). Before it, every row on every install read this.
    // owasp_web and owasp_llm legitimately still do (W16-11), so the rows are
    // named rather than the string being asserted absent from the table.
    await expect(coverage.getByTestId('scanner-row-secrets')).not.toContainText(
      'not in this build',
    );
    await expect(coverage.getByTestId('scanner-row-semgrep')).not.toContainText(
      'not in this build',
    );

    await expect(coverage.getByTestId('scanner-row-secrets')).toHaveAttribute(
      'data-state',
      'never_run',
    );
    await page.getByRole('button', { name: 'Run scans now' }).click();

    // The button says what it started, rather than leaving someone to guess.
    await expect(page.getByText(/^Started /)).toBeVisible();

    // Then the table stops saying "never". Polled through a reload because the
    // coverage payload is fetched on load, and that is what the person who
    // pressed the button does.
    await expect(async () => {
      await page.reload();
      await expect(coverage.getByTestId('scanner-row-secrets')).not.toHaveAttribute(
        'data-state',
        'never_run',
      );
    }).toPass({ timeout: 120_000, intervals: [3_000] });

    // A VERSION, which only a REGISTERED scanner can supply (W16-28). scan_runs
    // recorded "unregistered" for eight waves because getScanner() was always
    // undefined — so this is the assertion that cannot pass by the row simply
    // having changed for some other reason.
    await expect(coverage.getByTestId('scanner-row-secrets')).toContainText('secrets.v1');

    // NOTHING reached GitHub. A 401 here is the demo's fake credential landing
    // on api.github.com — the failure W16-29 was, and the one a future change
    // to scripts/dev.mjs's forge wiring would bring straight back.
    const table = (await coverage.textContent()) ?? '';
    expect(table).not.toContain('401');
    expect(table).not.toContain('api.github.com');
    // And the archive endpoint exists (W16-30): a 404 here is the fake forge
    // having no tarball route, which stopped every snapshot scanner.
    expect(table).not.toContain('archive request returned');
  });
});
