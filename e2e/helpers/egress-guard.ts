import { expect, type Page } from '@playwright/test';

// Runtime egress guard (FR-API-2, C1): the browser must never reach a forge or
// LLM host directly — the web app talks only to /api/v1, which reads Postgres.
// Any request to a forbidden host is aborted and recorded; assertNoForbidden()
// fails the test if one was attempted.
const FORBIDDEN_HOSTS = [
  /(^|\.)github\.com/,
  /githubusercontent\.com/,
  /api\.github\.com/,
  /anthropic\.com/,
  /:1234(\/|$)/, // LM Studio
];

export interface EgressGuard {
  assertNoForbidden(): void;
}

export async function installEgressGuard(page: Page): Promise<EgressGuard> {
  const hits: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (FORBIDDEN_HOSTS.some((re) => re.test(new URL(url).host + new URL(url).pathname))) {
      hits.push(url);
      void route.abort();
      return;
    }
    void route.continue();
  });
  return {
    assertNoForbidden() {
      expect(hits, `forbidden egress attempted: ${hits.join(', ')}`).toEqual([]);
    },
  };
}
