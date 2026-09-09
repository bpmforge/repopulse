import { expect, test } from '@playwright/test';

// Navigation after the W17-14 regrouping.
//
// The rename is PRESENTATION ONLY, so the thing that must be proven is that
// nothing moved: every destination that worked before still works by click, by
// keyboard, by pasted URL and by Back. And the narrow-screen drawer has to be
// operable, because what it replaces — nine unlabelled icons — was not.

const ALL_DESTINATIONS = [
  '/',
  '/repos',
  '/findings',
  '/plans',
  '/reports',
  '/admin',
  '/me',
  '/pull-requests',
  '/views',
];

test.describe('desktop navigation', () => {
  test('every destination is reachable by PASTED URL', async ({ page }) => {
    // The contract the rename must not break: URLs are what bookmarks, reports
    // and shared links contain.
    for (const path of ALL_DESTINATIONS) {
      const res = await page.goto(path);
      expect(res?.status(), `${path} did not load`).toBeLessThan(400);
      await expect(page.getByTestId('main')).toBeVisible();
    }
  });

  test('the renamed destinations keep their old paths', async ({ page }) => {
    await page.goto('/');
    // "Reviews" is /findings; "Settings" is /admin.
    await expect(page.getByTestId('rail-findings')).toHaveText(/Reviews/);
    await expect(page.getByTestId('rail-admin')).toHaveText(/Settings/);
    expect(await page.getByTestId('rail-findings').getAttribute('href')).toContain('/findings');
    expect(await page.getByTestId('rail-admin').getAttribute('href')).toContain('/admin');
  });

  test('the Workspace group is one click away, not deleted', async ({ page }) => {
    await page.goto('/');
    for (const id of ['rail-me', 'rail-pull-requests', 'rail-views']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
  });

  test('clicking through and going Back returns to the previous screen', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('rail-repos').click();
    await expect(page).toHaveURL(/\/repos/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$|\/\?/);
  });

  test('the active item is marked for the Workspace group too', async ({ page }) => {
    await page.goto('/me');
    await expect(page.getByTestId('rail-me')).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('narrow screens (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('there is NO page-level horizontal overflow', async ({ page }) => {
    // The measured baseline defect: the icon rail ate 56px of 390 and the page
    // scrolled sideways.
    for (const path of ['/', '/repos', '/findings']) {
      await page.goto(path);
      await expect(page.getByTestId('main')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });

  test('the drawer opens from a LABELLED trigger and navigates', async ({ page }) => {
    await page.goto('/');
    const trigger = page.getByTestId('nav-drawer-trigger');
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveText(/Menu/);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await trigger.click();
    await expect(page.getByTestId('nav-drawer')).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await page.getByTestId('drawer-repos').click();
    await expect(page).toHaveURL(/\/repos/);
    // Closed after navigating, rather than sitting over the screen just asked for.
    await expect(page.getByTestId('nav-drawer')).toHaveCount(0);
  });

  test('Escape closes it and focus returns to the trigger', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-drawer-trigger').click();
    await expect(page.getByTestId('nav-drawer')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('nav-drawer')).toHaveCount(0);
    await expect(page.getByTestId('nav-drawer-trigger')).toBeFocused();
  });

  test('the drawer is fully operable by keyboard alone', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-drawer-trigger').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('nav-drawer')).toBeVisible();
    // Focus moved INTO the drawer rather than being left on the page behind.
    const inside = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="nav-drawer"]')?.contains(document.activeElement)),
    );
    expect(inside).toBe(true);
  });

  test('the desktop rail is not rendered at this width', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('rail')).toBeHidden();
  });
});
