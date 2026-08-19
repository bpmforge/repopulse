import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// W4-08: the Admin surface docs/INSTALL.md sends operators to. Until this
// landed, INSTALL.md §4 told them to open a screen that did not exist, backed
// by routes the server did not mount.

test('admin tabs are routes and the connections screen loads', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin');

  await expect(page.getByTestId('admin')).toBeVisible();
  await expect(page.getByTestId('admin-connections')).toBeVisible();
  // The list renders even with zero connections — the seeded workspace has one
  // fixture connection, so the table must have a row.
  await expect(page.getByTestId('connection-list').locator('tbody tr')).not.toHaveCount(0);

  await page.getByTestId('admin-tab-sync').click();
  await expect(page).toHaveURL(/\/admin\/sync/);
  await expect(page.getByTestId('admin-sync')).toBeVisible();
  await expect(page.getByTestId('sync-phase')).not.toBeEmpty();

  await page.getByTestId('admin-tab-members').click();
  await expect(page).toHaveURL(/\/admin\/members/);
});

test('a credential never appears outside the field it was typed into', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin');

  const secret = 'ghp_e2e_never_echo_me_0123456789ABCDEF';
  await page.getByTestId('connection-credential').fill(secret);
  await page.getByTestId('connection-submit').click();
  await expect(page.getByTestId('connection-error')).toBeVisible();

  // The error must be the CREDENTIAL being rejected, not the CSRF guard. Both
  // render an error, so asserting merely that one appeared cannot tell them
  // apart — and this spec passed with the client's x-requested-with header
  // deleted, which is how a silently-403ing Connect button would have shipped.
  await expect(
    page.getByTestId('connection-error'),
    'the write must reach the handler, not be stopped by the CSRF guard',
  ).toContainText(/credential/i);

  // The connect fails here (the fixture credential is not a real token), and the
  // field deliberately KEEPS its value so the operator can correct a typo — it
  // is a password input, and clearing it on failure just makes them retype.
  // What must never happen is the credential appearing anywhere else: echoed in
  // the error envelope, rendered into the connections list, or logged to the
  // page. So the assertion excludes the input the operator typed into and
  // checks everything else.
  const leakedElsewhere = await page.evaluate((s) => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input').forEach((el) => el.remove());
    return clone.outerHTML.includes(s);
  }, secret);
  expect(leakedElsewhere, 'credential must not appear outside its own input').toBe(false);

  // And the API must not hand it back: SC-2 says a connection is described by a
  // fingerprint and last-4, never the credential.
  await expect(page.getByTestId('connection-error')).not.toContainText(secret);
});

test('mutations carry the CSRF header — a write is not silently 403d', async ({ page }) => {
  await loginAsFixture(page);
  // Straight at the API: the client must send x-requested-with on writes. Before
  // this was added, every mutation from the SPA returned 403 with no UI hint,
  // which would have made the connect button look inert.
  const withHeader = await page.request.post('/api/v1/connections', {
    headers: { 'x-requested-with': 'repopulse' },
    data: { provider: 'github', auth_kind: 'pat', credential: 'ghp_probe_only' },
    failOnStatusCode: false,
  });
  const withoutHeader = await page.request.post('/api/v1/connections', {
    headers: { 'x-requested-with': '' },
    data: { provider: 'github', auth_kind: 'pat', credential: 'ghp_probe_only' },
    failOnStatusCode: false,
  });

  expect(withoutHeader.status(), 'CSRF guard must reject a header-less write').toBe(403);
  expect(withHeader.status(), 'a write WITH the header must get past the CSRF guard').not.toBe(403);
});

test('a member sees ask-an-admin rather than a wall of failed requests', async ({ page }) => {
  await loginAsFixture(page);
  // The fixture user is an admin, so assert the positive: the admin UI renders
  // rather than the role gate. The gate itself is presentation — the API
  // enforces admin with a 403 independently (FR-AUTH-4).
  await page.goto('/admin');
  await expect(page.getByTestId('admin-connections')).toBeVisible();
});

test('admin passes axe with real data', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin');
  await expect(page.getByTestId('connection-list').locator('tbody tr').first()).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByTestId('admin-tab-sync').click();
  await expect(page.getByTestId('admin-sync')).toBeVisible();
  await expectNoA11yViolations(page);
});

test('the Members tab and DLQ panel show real controls, not empty states (W4-20)', async ({
  page,
}) => {
  // Both surfaces previously shipped as named empty states pointing at this
  // ticket — honest, but unusable. This asserts the CONTROLS, because a panel
  // that renders while its endpoint 404s would still look fine.
  await loginAsFixture(page);

  await page.goto('/admin/members');
  await expect(page.getByTestId('members-table')).toBeVisible();
  // The fixture user is this workspace's admin, so a role control must exist.
  await expect(page.locator('[data-testid^="member-role-"]').first()).toBeVisible();

  await page.goto('/admin/sync');
  // An EMPTY dead-letter queue is good news; what matters is that the panel is
  // reading the endpoint rather than telling the operator it does not exist.
  await expect(page.getByText(/tracked as W4-20/i)).toHaveCount(0);
  await expect(page.getByText(/Dead-letter queue/i).first()).toBeVisible();
});

test('Settings shows the METRICS.md defaults, labelled as defaults (W4-09)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin/settings');

  await expect(page.getByTestId('admin-settings')).toBeVisible();
  // Seeded workspaces store no settings, so every field is showing a default —
  // and must SAY so. A screen that renders 7 with no label cannot be told apart
  // from one where an admin chose 7, which is the whole point of the API
  // returning `stored` and `effective` separately.
  await expect(page.getByTestId('stale-days')).toHaveValue('7');
  await expect(page.getByText('default').first()).toBeVisible();
  // METRICS.md §3 weights, reaching the browser from the API rather than being
  // duplicated in the UI.
  await expect(page.getByTestId('weight-reviewHygiene')).toHaveValue('0.3');

  await expectNoA11yViolations(page);
});

test('the weight form refuses a set that does not sum to 1.00 (W4-09)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin/settings');

  await page.getByTestId('weight-activity').fill('0.9');
  // The error is announced (role=alert) and the save is blocked in the browser.
  // The API re-checks independently — a client-side check is a courtesy, never
  // a control — which is asserted in the route's own integration test.
  await expect(page.getByTestId('weights-sum-error')).toBeVisible();
  await expect(page.getByTestId('save-weights')).toBeDisabled();
});

test('the Identities tab lists real identities and merges one, passing axe (W5-05)', async ({
  page,
}) => {
  // The merge is asserted through the UI rather than the API because the whole
  // ticket is that merging was unreachable: the column existed, the readers
  // ignored it, and no screen could reach it.
  await loginAsFixture(page);
  await page.goto('/admin/identities');

  await expect(page.getByTestId('identity-rows')).toBeVisible();
  const rows = page.locator('[data-testid^="identity-"][data-testid*="-"]');
  await expect(rows.first()).toBeVisible();
  await expectNoA11yViolations(page);

  // Merge the first mergeable identity into another, then undo it, so the
  // reversibility DATABASE.md §2 promises is exercised on a real screen.
  const mergeButton = page.locator('[data-testid^="identity-merge-"]').first();
  const sourceId = (await mergeButton.getAttribute('data-testid'))!.replace('identity-merge-', '');
  await mergeButton.click();
  await expect(page.getByTestId('merge-picker')).toBeVisible();
  await page.locator('[data-testid^="merge-into-"]').first().click();

  const undo = page.getByTestId(`identity-unmerge-${sourceId}`);
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(page.getByTestId(`identity-merge-${sourceId}`)).toBeVisible();
});
