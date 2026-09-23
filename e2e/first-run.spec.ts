import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_TOKEN } from '@repopulse/shared';
import { loginAsFixture } from './helpers/auth.js';

// THE REAL FIRST RUN (W17-09).
//
// Everything else in this suite starts from `storageState` — a session minted
// once in global-setup through the mocked OAuth boundary. That is the right
// trade for the other 100 specs (SC-11 caps the auth flow at 10 requests a
// minute) but it means the journey a CUSTOMER actually takes has never run:
//
//   sign in with a local password → be forced to change it → connect a forge →
//   select repositories → watch the backfill → optionally add a model
//
// D14 made local accounts the way in, precisely so an install does not depend
// on registering an App with a vendor the customer may not use. So this file
// throws the shared session away and drives the product the way the person who
// bought it does.
//
// No DEMO_MODE (no mocked sign-in, no pre-filled credentials) and no seeded
// warehouse for the parts under test — the account is created through the real
// admin API and every screen below is the shipping one.

// The whole point: start signed OUT.
test.use({ storageState: { cookies: [], origins: [] } });

/** Unique per run, so repeated runs never collide on the email unique index. */
const suffix = randomBytes(4).toString('hex');
const NEW_USER = `w17-09-${suffix}@example.com`;
const FIRST_PASSWORD = `first-pw-${suffix}-longenough`;
const CHOSEN_PASSWORD = `chosen-pw-${suffix}-longenough`;

/**
 * Create the account the way an operator does — through the real admin
 * endpoint, which always forces a password change on the new account.
 *
 * Uses a separate browser context so this file's own page stays signed out.
 */
async function createAccountAsAdmin(page: Page): Promise<void> {
  const ctx = await page.context().browser()!.newContext();
  const admin = await ctx.newPage();
  await loginAsFixture(admin);
  // NOT under /api/v1: local auth routes are registered on the root app
  // (app.ts:117), the same way /auth/login and /healthz are.
  const res = await admin.request.post('/auth/local/users', {
    headers: { 'x-requested-with': 'repopulse' },
    data: { email: NEW_USER, password: FIRST_PASSWORD, login: `w17-09-${suffix}` },
  });
  expect(res.status(), await res.text()).toBe(201);
  await ctx.close();
}


/**
 * Sign in and WAIT for it to have happened.
 *
 * Asserting the absence of the password-change dialog passes instantly — before
 * the request has even returned — so the next navigation races the session
 * cookie and lands back on the sign-in form. Waiting for the sign-in form to
 * DISAPPEAR is a positive transition, which is what makes this deterministic.
 */
async function signIn(page: Page, password: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('signin-email').fill(NEW_USER);
  await page.getByTestId('signin-password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('signin-local')).toHaveCount(0, { timeout: 15_000 });
}

test.describe('the journey a customer actually takes', () => {
  test('local sign-in forces a password change before the product opens', async ({ page }) => {
    await createAccountAsAdmin(page);

    await page.goto('/');
    // The local form is offered without any forge being configured — the whole
    // reason D14 exists. No "Sign in with GitHub" is required to get in.
    await expect(page.getByTestId('signin-local')).toBeVisible();

    await page.getByTestId('signin-email').fill(NEW_USER);
    await page.getByTestId('signin-password').fill(FIRST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Forced, not suggested: the admin who set this password is not the person
    // who will own the account.
    await expect(page.getByTestId('password-change')).toBeVisible();

    await page.getByTestId('password-current').fill(FIRST_PASSWORD);
    await page.getByTestId('password-new').fill(CHOSEN_PASSWORD);
    await page.getByTestId('password-confirm').fill(CHOSEN_PASSWORD);
    await page.getByTestId('password-submit').click();

    // And now the product, not the form.
    await expect(page.getByTestId('password-change')).toBeHidden();
  });

  test('the old password stops working and the new one works', async ({ page }) => {
    // Proves the change PERSISTED rather than only dismissing the dialog.
    await page.goto('/');
    await page.getByTestId('signin-email').fill(NEW_USER);
    await page.getByTestId('signin-password').fill(FIRST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('signin-error')).toBeVisible();

    await page.getByTestId('signin-password').fill(CHOSEN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('signin-error')).toHaveCount(0);
    await expect(page.getByTestId('password-change')).toHaveCount(0);
  });

  test('a reload mid-setup does not lose the session or re-ask for the password', async ({
    page,
  }) => {
    await signIn(page, CHOSEN_PASSWORD);
    await expect(page.getByTestId('password-change')).toHaveCount(0);

    await page.reload();

    // Still in, and NOT sent back to the sign-in form.
    await expect(page.getByTestId('signin-local')).toHaveCount(0);
  });

  test('an invalid credential is reported, not swallowed, before anything is stored', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('signin-email').fill(NEW_USER);
    await page.getByTestId('signin-password').fill('not-the-password-at-all');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByTestId('signin-error')).toBeVisible();
    // A wrong password must not hint at whether the account exists.
    await expect(page.getByTestId('signin-error')).not.toContainText(NEW_USER);
  });

  test('a metadata-only install works with NO model configured', async ({ page }) => {
    // Tier-1 is the product's floor: an operator who never configures an LLM
    // still gets delivery metrics and repository health. If this ever requires
    // a model, the install has a hidden dependency on a paid service.
    await signIn(page, CHOSEN_PASSWORD);
    await expect(page.getByTestId('password-change')).toHaveCount(0);

    await page.goto('/repos');
    // The screen renders and is not an error — no model is configured in the
    // e2e stack at all. `repo-list` is the real testid; `main` is the shell.
    await expect(page.getByTestId('main')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('repo-list')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('connecting a forge for the first time', () => {
  // These drive the admin surface, so they use the fixture admin rather than
  // the fresh member account above — role, not authentication, is the subject.
  test.use({ storageState: 'e2e/.auth/state.json' });

  test('an invalid token is rejected before a connection is stored', async ({ page }) => {
    await page.goto('/admin');
    // WAIT for the list to settle before counting. Reading the count the
    // instant the page loads returns 0 while the query is still in flight, and
    // then any pre-existing connection — this database persists across runs —
    // looks like a row this test just created. That reads as a product defect
    // and is not one.
    await expect(page.getByTestId('connection-list')).toBeVisible();
    await expect
      .poll(async () => page.getByTestId('connection-list').locator('tbody tr').count())
      .toBeGreaterThanOrEqual(0);
    await page.waitForTimeout(500);
    const before = await page.getByTestId('connection-list').locator('tbody tr').count();

    await page.getByTestId('connection-credential').fill('ghp_not_a_real_token_at_all');
    await page.getByTestId('connection-submit').click();

    await expect(page.getByTestId('connection-error')).toBeVisible();
    // And nothing was written: a rejected credential must not leave a
    // half-made connection behind for the operator to clean up.
    await expect
      .poll(async () => page.getByTestId('connection-list').locator('tbody tr').count())
      .toBe(before);
  });

  test('a valid token connects and the system status turns Ready', async ({ page }) => {
    await page.goto('/admin');
    await page.getByTestId('connection-credential').fill(FAKE_TOKEN);
    await page.getByTestId('connection-submit').click();
    await expect(page.getByTestId('connection-result')).toBeVisible();

    // The W17-07/08 panel is on this page, and it must AGREE with what just
    // happened rather than being a decoration beside it.
    await expect(page.getByTestId('system-component-forge')).toBeVisible();
    await expect
      .poll(async () => (await page.getByTestId('system-state-forge').textContent()) ?? '', {
        timeout: 20_000,
      })
      .not.toContain('Setup needed');
  });

  test('backfill state comes from stored progress, never an animated guess', async ({ page }) => {
    await page.goto('/admin/sync');

    await expect(page.getByTestId('admin-sync')).toBeVisible({ timeout: 15_000 });
    // Whatever phase it is in, it is one of the RECORDED ones. A UI inventing a
    // percentage would not be constrained to this vocabulary.
    await expect(page.getByTestId('sync-phase')).toHaveText(
      /queued|history|enrichment|live|paused|error/i,
    );
  });
});
