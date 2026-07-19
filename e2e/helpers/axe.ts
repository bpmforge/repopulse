import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// axe a11y scan helper (ROADMAP W4 gate: axe on all MVP routes). Every screen
// spec calls this after the page settles; a violation fails the run with the
// offending rule ids.
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    results.violations,
    `a11y violations: ${results.violations.map((v) => v.id).join(', ')}`,
  ).toEqual([]);
}
