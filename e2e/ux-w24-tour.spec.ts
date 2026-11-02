import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { SEED_REPO_NAMES, core, createDb, read } from '@repopulse/shared';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// W24: whole-page pictures of the four screens the UX review flagged - the Models
// page with and without a connection, the repository's Security tab and its AI
// review tab - in light and dark, with axe on each. Run before and after a change
// to show what moved.
//
// Opt-in, because it seeds rows and writes PNGs:
//
//   E2E_UX24_TOUR=1 pnpm e2e e2e/ux-w24-tour.spec.ts
//
// PNGs go to docs/screenshots/w24/after (override with UX24_OUT). Every row it
// creates is removed afterwards.

const enabled = process.env.E2E_UX24_TOUR === '1';
const OUT = process.env.UX24_OUT ?? join('docs', 'screenshots', 'w24', 'after');

test.describe('W24 UX tour', () => {
  test.skip(!enabled, 'set E2E_UX24_TOUR=1 to run the screenshot tour');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1280, height: 900 } });

  const url = process.env.DATABASE_URL;
  const db = createDb(url ?? 'postgres://invalid');
  let WS = 0;
  let REPO = 0;

  async function wipe() {
    await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, WS));
    await db.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, WS));
    await db.delete(core.llmRoutingPolicy).where(eq(core.llmRoutingPolicy.workspaceId, WS));
    await db.delete(core.llmProviders).where(eq(core.llmProviders.workspaceId, WS));
  }

  test.beforeAll(async () => {
    if (!url) throw new Error('DATABASE_URL is not set');
    mkdirSync(OUT, { recursive: true });
    const [repo] = await db
      .select()
      .from(core.repos)
      .where(eq(core.repos.name, SEED_REPO_NAMES[0] as string))
      .limit(1);
    REPO = repo!.id;
    WS = repo!.workspaceId;
    await wipe();
  });
  test.afterAll(async () => {
    await wipe();
    await db.$client.end();
  });

  async function provider(name: string, baseUrl: string) {
    const [p] = await db
      .insert(core.llmProviders)
      .values({
        workspaceId: WS,
        name,
        kind: 'openai_compatible',
        baseUrl,
        model: 'qwen/qwen3.8-27b',
        allowPublicHost: false,
      })
      .returning({ id: core.llmProviders.id });
    return p!.id;
  }

  /** The whole page, light then dark. */
  async function shoot(page: Page, name: string) {
    for (const theme of ['light', 'dark'] as const) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme) {
        await page.getByTestId('theme-toggle').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      }
      // The app scrolls inside its main column, not the document, so fullPage
      // alone stops at the first screen: grow the viewport to the tallest scroller.
      const height = await page.evaluate(() =>
        Math.max(...Array.from(document.querySelectorAll('*'), (el) => el.scrollHeight)),
      );
      await page.setViewportSize({ width: 1280, height: Math.min(height + 40, 12_000) });
      await page.screenshot({
        path: join(OUT, `${name}-${theme}.png`),
        animations: 'disabled',
      });
      if (process.env.UX24_SKIP_AXE !== '1') await expectNoA11yViolations(page);
    }
  }

  test('Models page with no connection', async ({ page }) => {
    await loginAsFixture(page);
    await page.goto('/admin/models');
    await expect(page.getByTestId('models-wizard')).toBeVisible();
    await shoot(page, '01-models-no-connection');
  });

  test('Models page with two connections and one routed role', async ({ page }) => {
    const lm = await provider('LM Studio', 'http://10.0.0.5:1234/v1');
    await provider('Backup (LAN)', 'http://10.0.0.6:1234/v1');
    await db
      .insert(core.llmRoleRoutes)
      .values({ workspaceId: WS, role: 'security', position: 0, providerId: lm });
    await loginAsFixture(page);
    await page.goto('/admin/models');
    await expect(page.getByTestId('llm-routing')).toBeVisible();
    await expect(page.getByTestId('model-eval-table')).toBeVisible();
    await shoot(page, '02-models-with-connections');
  });

  test('Security tab', async ({ page }) => {
    await loginAsFixture(page);
    await page.goto(`/repos/${REPO}/security`);
    await expect(page.getByTestId('security-coverage')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/Loading/);
    await shoot(page, '03-security-tab');
  });

  test('AI review tab', async ({ page }) => {
    await loginAsFixture(page);
    await page.goto(`/repos/${REPO}/ai-review`);
    await expect(page.getByTestId('ai-pass-panel')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/Loading/);
    await shoot(page, '04-ai-review-tab');
  });
});
