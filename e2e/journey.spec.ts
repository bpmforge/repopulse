import { test, expect, type Page } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';
import { withNullPersona, withReviewRequested } from './helpers/warehouse.js';

// The first-run journey (W4-10, UX_SPEC §6 + R-A1/R-A2).
//
// Every assertion here runs against a genuinely null persona column rather than
// a mocked store: `users.persona IS NULL` is what the picker keys on, and the
// seeder sets a persona so the modal does not cover every other spec.

const FIXTURE = 'fixture-dev';

test('first login asks one question and routes to that persona home (R-A2)', async ({ page }) => {
  const restore = await withNullPersona(FIXTURE);
  try {
    await loginAsFixture(page);
    await page.goto('/');

    await expect(page.getByTestId('persona-picker')).toBeVisible();
    // It is a real dialog, not a styled div — screen readers need the role and
    // the label, and the a11y gate is part of this ticket.
    await expect(page.getByRole('dialog', { name: /what best describes you/i })).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByTestId('persona-developer').click();

    // P2 → My Focus (UX_SPEC §6). The route comes from the API's own answer, so
    // this also proves the client is not carrying a second copy of the mapping.
    await expect(page).toHaveURL(/\/me/);
    await expect(page.getByTestId('persona-picker')).toHaveCount(0);

    // Persisted, not just in memory: a reload must not ask again.
    await page.reload();
    await expect(page.getByTestId('persona-picker')).toHaveCount(0);
  } finally {
    await restore();
  }
});

test('the persona is changeable from the user menu (R-A2)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/');

  await page.getByTestId('user-menu').click();
  await expect(page.getByTestId('user-menu-panel')).toBeVisible();
  // The seeder's fixture is a lead, and the menu must show WHICH one is current
  // — a switcher that cannot tell you your current setting is a guess box.
  await expect(page.getByTestId('user-menu-persona-lead')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('user-menu-persona-security').click();
  await page.reload();
  await page.getByTestId('user-menu').click();
  await expect(page.getByTestId('user-menu-persona-security')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Leave the fixture as the suite found it.
  await page.getByTestId('user-menu-persona-lead').click();
});

test('the onboarding checklist shows the admin variant and stays dismissed (R-A1)', async ({
  page,
}) => {
  const restore = await withNullPersona(FIXTURE);
  try {
    await loginAsFixture(page);
    await page.goto('/');
    // Answer the picker first — it is modal, which is the point of it.
    await page.getByTestId('persona-lead').click();

    await expect(page.getByTestId('onboarding-checklist')).toBeVisible();
    // The fixture user is this workspace's admin, so the ADMIN variant renders:
    // setup steps, not the member orientation tour.
    // (Renamed "Add people and assign roles" in W20-17.)
    await expect(page.getByRole('link', { name: /assign roles/i })).toBeVisible();

    await page.getByTestId('onboarding-dismiss').click();
    await expect(page.getByTestId('onboarding-checklist')).toHaveCount(0);

    // Dismissal is stored per user, so a reload must not bring it back.
    await page.reload();
    await expect(page.getByTestId('onboarding-checklist')).toHaveCount(0);
  } finally {
    await restore();
  }
});

test('the Pull Requests rail badge counts the review queue, and Findings counts what it says (R-A4)', async ({
  page,
}) => {
  await loginAsFixture(page);
  // The seeder records no review requests; the forge asking us is the input.
  const restore = await withReviewRequested(FIXTURE);
  try {
    await page.goto('/');
    await badgesMatchTheirCounts(page);
  } finally {
    await restore();
  }
});

async function badgesMatchTheirCounts(page: Page): Promise<void> {
  // The badges are the counts their own endpoints give, never a guess. Since
  // W20-16 (DSH-64/85) the Pull Requests count is the PRs the forge says ask
  // YOU (requested: true) and is its own link to the queue on My Focus; since
  // W20-10 (X-03) Findings counts new serious findings since you last opened
  // the inbox. A zero renders as nothing, not "0" (W4-21).
  const queue = (await (await page.request.get('/api/v1/me/review-queue')).json()) as {
    items: { requested?: boolean | null }[];
  };
  const asked = queue.items.filter((i) => i.requested === true).length;
  expect(asked).toBeGreaterThan(0);
  const prBadge = page.getByTestId('rail-badge-pull-requests');
  await expect(prBadge).toHaveText(String(asked));
  await expect(prBadge).toHaveAttribute('href', /\/me.*#review-queue/);

  const inbox = (await (await page.request.get('/api/v1/me/inbox')).json()) as {
    findings_count: number;
  };
  const findingsBadge = page.getByTestId('rail-badge-findings');
  if (inbox.findings_count > 0) {
    await expect(findingsBadge).toHaveText(String(inbox.findings_count));
  } else {
    await expect(page.getByTestId('rail-findings')).not.toHaveText(/\d/);
  }
}
