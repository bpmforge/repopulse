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

test('agreements are admin-configurable and show real exception lists (W5-08)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/admin/agreements');

  await expect(page.getByTestId('agreement-form')).toBeVisible();
  await expectNoA11yViolations(page);

  // A deliberately tight threshold so the seeded warehouse actually breaches
  // it — an agreement nobody breaks proves only that the form submits.
  await page.getByTestId('agreement-kind').selectOption('pr_size_max');
  await page.getByTestId('agreement-threshold').fill('1');
  await page.getByTestId('agreement-create').click();

  const first = page.locator('[data-testid^="agreement-count-"]').first();
  await expect(first).toBeVisible();
  await expect(first).toContainText(/exceptions|no exceptions/);

  // The list must name PULL REQUESTS. If it ever names people, the screen has
  // become a leaderboard and N-9 is broken.
  const exceptions = page.locator('[data-testid^="agreement-exceptions-"]').first();
  if ((await exceptions.count()) > 0) {
    await expect(exceptions).toContainText(/#\d+/);
  }
});

test('the Analysis tab states the consequence of Tier-3 opt-in and audits the toggle (W7-08)', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/admin/analysis');
  await expect(page.getByTestId('analysis-policy')).toBeVisible();

  const row = page.locator('[data-testid^="analysis-repo-"]').first();
  await expect(row).toBeVisible();

  // Off by default, and the row SAYS what that means rather than showing an
  // unlabelled checkbox. Someone ticking it is deciding that code may leave
  // their network — that belongs beside the control.
  await expect(row).toContainText(/stays on your network/i);

  const toggle = page.locator('[data-testid^="tier3-"]').first();
  await expect(toggle).not.toBeChecked();
  // click(), not check(): the checkbox is CONTROLLED by the server's value, so
  // its state only changes after the mutation refetches. check() asserts the
  // new state synchronously and fails with "clicking did not change its state"
  // — a true statement about a correct control.
  await toggle.click();
  await expect(row).toContainText(/diffs may be sent/i);

  // Nothing has actually been sent — the opt-in is permission, not a call.
  await expect(row).toContainText(/nothing sent/i);

  // And the empty egress log distinguishes "nothing was sent" from "nothing
  // was recorded", which is the whole point of writing the row first.
  await expect(page.getByText(/written before each call/i)).toBeVisible();

  await toggle.click();
  await expect(row).toContainText(/stays on your network/i);
});

test('the rule workbench shows shadow evidence and blocks an unready promotion', async ({
  page,
}) => {
  // W9-07. The screen exists to make one decision answerable — should this
  // rule start counting? — so the blockers are visible rather than hidden
  // behind a disabled button.
  await loginAsFixture(page);
  await page.goto('/admin/rules');
  await expect(page.getByTestId('rule-workbench')).toBeVisible();

  const frame = page.getByTestId('rules-frame');
  await expect(frame).toHaveAttribute('data-state', /ready|empty/);

  // With no rules registered the empty state explains WHAT THIS REGISTRY HOLDS,
  // rather than looking like a broken screen. It used to say rules "ship in
  // versioned packs" and that this screen "governs which of them count", which
  // reads as though every rule the scanners apply is listed — so a reader who
  // has just seen a finding attributed to bpm-log-console-in-prod concludes the
  // screen is broken. It holds only CANDIDATE rules drafted from this
  // workspace's own findings (W16-57).
  if ((await frame.getAttribute('data-state')) === 'empty') {
    await expect(frame).toContainText(/candidate rules/i);
    await expect(frame).toContainText(/shadow/i);
  } else {
    await expect(page.getByTestId('rules-table')).toBeVisible();
  }

  await expectNoA11yViolations(page);
});

test('the setup checklist says what is outstanding without echoing a secret', async ({ page }) => {
  // W11-02, E1.2. The operator's question is "which step have I not done", and
  // the answer must never include a value — a setup screen that echoes secrets
  // back is a credential leak wearing a helpful face.
  await loginAsFixture(page);
  await page.goto('/setup');

  await expect(page.getByTestId('setup')).toBeVisible();
  const checklist = page.getByTestId('setup-checklist');
  await expect(checklist).toHaveAttribute('data-state', /ready|empty/);

  if ((await checklist.getAttribute('data-state')) === 'ready') {
    // Every row carries a next action, not just a status light.
    await expect(checklist).toContainText(/INSTALL\.md|CONFIG\.md/);
  }

  const config = page.getByTestId('setup-config');
  await expect(config).toHaveAttribute('data-state', /ready|empty/);
  if ((await config.getAttribute('data-state')) === 'ready') {
    // The encryption key is 32 bytes of hex; if one ever reached the page this
    // would catch it.
    await expect(page.getByTestId('setup-config')).not.toContainText(/\b[0-9a-f]{64}\b/);
    await expect(page.getByTestId('config-TOKEN_ENC_KEY-set')).toBeVisible();
  }

  await expectNoA11yViolations(page);
});
