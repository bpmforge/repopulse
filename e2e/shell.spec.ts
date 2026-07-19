import { test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers/axe.js';
import { installEgressGuard } from './helpers/egress-guard.js';

// Shell smoke (W4-00): the app root renders, passes axe, and makes no forbidden
// forge/LLM egress. This is the harness every subsequent screen ticket extends
// (its axe + egress-guard + seeded-data pattern). The full 6 core journeys
// (TESTING.md §6) land with the W4 screen tickets once the shell serves routes.
test('shell route renders, passes axe, and never reaches a forge/LLM host', async ({ page }) => {
  const guard = await installEgressGuard(page);
  await page.goto('/');
  await expectNoA11yViolations(page);
  guard.assertNoForbidden();
});
