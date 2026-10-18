import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';

// W19-07: the install docs' LM Studio worked example, driven through the real
// wizard against a REAL LM Studio. Opt-in, because it needs a model server:
//
//   E2E_LM_STUDIO=1 E2E_LM_STUDIO_MODEL=<loaded model id> pnpm e2e e2e/models-lm-studio.spec.ts
//
// It is slow on purpose-built hardware limits, not by design: the probe makes
// four real model calls, and a reasoning model takes tens of seconds to minutes
// for each. The browser never talks to LM Studio (the egress guard forbids it);
// the API does, exactly as in a real install.

const enabled = process.env.E2E_LM_STUDIO === '1';
const MODEL = process.env.E2E_LM_STUDIO_MODEL ?? '';

test.describe('the LM Studio worked example', () => {
  test.skip(
    !enabled || MODEL === '',
    'set E2E_LM_STUDIO=1 and E2E_LM_STUDIO_MODEL to run against a real LM Studio',
  );
  test.setTimeout(8 * 60_000);

  test('local -> preset -> test -> save -> roles -> review says it stays home', async ({
    page,
    request,
  }) => {
    await loginAsFixture(page);
    await page.goto('/admin/models');

    await page.getByTestId('wizard-where-local').check();
    await page.getByTestId('wizard-next-0').click();

    await page.getByTestId('wizard-preset-lmstudio').click();
    await expect(page.getByTestId('wizard-base-url')).toHaveValue('http://localhost:1234/v1');
    await page.getByTestId('wizard-name').fill('E2E LM Studio');
    await page.getByTestId('wizard-model').fill(MODEL);

    await page.getByTestId('wizard-test').click();
    await expect(page.getByTestId('wizard-test-result')).toContainText('Reached it.', {
      timeout: 4 * 60_000,
    });
    // What the probe found is on the screen before anything is saved.
    await expect(page.getByTestId('capabilities')).toContainText('Streaming');

    await page.getByTestId('wizard-save').click();
    await expect(
      page.getByRole('heading', { name: /Which kinds of analysis should use E2E LM Studio/ }),
    ).toBeVisible({ timeout: 4 * 60_000 });

    await page.getByTestId('wizard-assign').click();
    const review = page.getByTestId('wizard-review');
    await expect(review).toBeVisible();
    await expect(page.getByTestId('wizard-review-security')).toContainText('Stays home.');
    await expect(page.getByTestId('wizard-review-security')).toContainText('Uses E2E LM Studio');

    // Leave the shared e2e warehouse as found: remove the connection (its
    // routing links go with it, by cascade).
    const list = await request.get('/api/v1/admin/llm-providers');
    const mine = (await list.json()).items.find(
      (p: { name: string }) => p.name === 'E2E LM Studio',
    );
    if (mine) {
      const res = await request.delete(`/api/v1/admin/llm-providers/${mine.id}`, {
        headers: { 'x-requested-with': 'repopulse' },
      });
      expect(res.status()).toBe(204);
    }
  });
});
