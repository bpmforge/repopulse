import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { expectNoA11yViolations } from './helpers/axe.js';

// Artifact intents on real surfaces (W6-09, FR-PLANS-5).
//
// Driven by data, not by clicking through the app: the target file comes from
// the hotspots API so the test navigates straight to a drill-down that exists.
// An earlier version hunted for a link and skipped when it found none, which
// is a test that proves nothing while looking green.

test('acknowledging a file hides it from the leaderboard AND says so', async ({ page, context }) => {
  await loginAsFixture(page);

  const res = await context.request.get('/api/v1/hotspots?window=30d&limit=10');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    items: { repoId: number; path: string }[];
    suppressed_count?: number;
  };
  expect(body.items.length, 'the fixture warehouse must have hotspots to acknowledge').toBeGreaterThan(0);
  const target = body.items[0]!;
  const before = body.items.length;

  await page.goto(`/repos/${target.repoId}/files/${target.path}`);
  await expect(page.getByTestId('intent-control')).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByTestId('intent-acknowledged').click();
  await expect(page.getByTestId('intent-acknowledged')).toHaveAttribute('aria-pressed', 'true');

  // The API drops the row and reports the count in the same response.
  await expect
    .poll(async () => {
      const again = await context.request.get('/api/v1/hotspots?window=30d&limit=10');
      return (await again.json()) as { items: unknown[]; suppressed_count?: number };
    })
    .toMatchObject({ suppressed_count: 1 });

  const after = await context.request.get('/api/v1/hotspots?window=30d&limit=10');
  const afterBody = (await after.json()) as { items: unknown[] };
  expect(afterBody.items.length).toBeLessThan(before);

  // And the board SAYS so. A leaderboard that omits rows silently is worse
  // than one that shows everything: the first person to notice the gap stops
  // trusting every other number on the screen.
  await page.goto('/');
  await expect(page.getByTestId('hotspot-suppressed')).toContainText(/acknowledged file/i);
});
