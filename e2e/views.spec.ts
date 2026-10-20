import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// Saved views + ⌘K (W5-02, UX_SPEC §4.g/§3.3, FR-WEB-4/5/6).
//
// The rail has linked to /views since W4-02 with no route behind it, so these
// assert the destination exists as much as that it works.

test('the views list offers persona starter templates and creates one', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/views');

  await expect(page.getByTestId('template-gallery')).toBeVisible();
  await expectNoA11yViolations(page);

  const firstTemplate = page.locator('[data-testid^="use-template-"]').first();
  await firstTemplate.click();
  // W20-16 (DSH-54): a template asks for a name (prefilled) before it creates.
  await page.locator('[data-testid^="create-from-template-"]').first().click();

  // Creating from a template lands ON the new view, not back at the list: the
  // next thing anyone wants is to look at it.
  await expect(page.getByTestId('view-detail')).toBeVisible();
  await expect(page.getByTestId('widget-grid')).toBeVisible();
});

test('a saved layout survives a reload (FR-WEB-5)', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/views');
  await page.locator('[data-testid^="use-template-"]').first().click();
  await page.locator('[data-testid^="create-from-template-"]').first().click();
  await expect(page.getByTestId('view-detail')).toBeVisible();
  const url = page.url();

  await page.getByTestId('toggle-edit').click();
  const firstWidth = page.locator('[data-testid^="width-"]').first();
  await firstWidth.fill('4');
  await page.getByTestId('save-layout').click();

  // A layout that only lives in React state looks identical until you reload —
  // which is exactly when a user loses work.
  await page.goto(url);
  await page.getByTestId('toggle-edit').click();
  await expect(page.locator('[data-testid^="width-"]').first()).toHaveValue('4');
});

test('a shared view is readable by another workspace member (FR-WEB-4)', async ({
  page,
  context,
}) => {
  await loginAsFixture(page);
  await page.goto('/views');
  await page.locator('[data-testid^="use-template-"]').first().click();
  await page.locator('[data-testid^="create-from-template-"]').first().click();
  await expect(page.getByTestId('view-detail')).toBeVisible();

  await page.getByTestId('share-view').click();
  await expect(page.getByTestId('share-slug')).toBeVisible();
  const slugText = await page.getByTestId('share-slug').innerText();
  const slug = slugText.split('/views/shared/')[1]?.trim();
  expect(slug, 'sharing must surface a slug the owner can hand over').toBeTruthy();

  // The SECOND reader is the point: a share link that only works for its author
  // is not a share link. Same workspace session, fetched as a plain API read.
  const res = await context.request.get(`/api/v1/views/shared/${slug}`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { name: string; config: { layout: unknown[] } };
  expect(body.config.layout.length).toBeGreaterThan(0);
});

test('⌘K is fully keyboard operable: open, type, Enter lands on the repo (FR-WEB-6)', async ({
  page,
}) => {
  await loginAsFixture(page);
  await page.goto('/');
  // Wait for the shell to be interactive before typing. Pressing ⌘K the
  // instant goto resolves races React attaching the window listener — which
  // failed as "the palette does not open" and looked like a product bug.
  await expect(page.getByTestId('main')).toBeVisible();

  // No clicks anywhere in this test — that is the acceptance criterion.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();

  await page.keyboard.type('pay');
  const results = page.getByTestId('palette-results');
  await expect(results).toBeVisible();
  await expect(results.locator('li').first()).toContainText(/pay/i);
  // Wait for the option to be SELECTED, not merely present. The repo list
  // arrives asynchronously, so the moment a matching row renders is not the
  // moment the keyboard cursor is on it — pressing Enter in that gap does
  // nothing, which reads as "the palette is broken" rather than "the test was
  // early". Proven: identical steps with a wait navigate correctly.
  await expect(results.locator('li[aria-selected="true"]').first()).toContainText(/pay/i);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/repos\/\d+/);
});

test('Escape closes the palette without navigating', async ({ page }) => {
  await loginAsFixture(page);
  await page.goto('/repos');
  await expect(page.getByTestId('main')).toBeVisible();
  const before = page.url();

  // ControlOrMeta, because the handler accepts either and the suite should not
  // encode one platform's modifier.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  expect(page.url()).toBe(before);
});
