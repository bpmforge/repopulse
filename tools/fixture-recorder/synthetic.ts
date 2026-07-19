import { writeFixture } from './record.js';

// Two fixtures are authored, not recorded live:
//  - 202 stats-warmup only appears when GitHub's stats cache is COLD, which
//    can't be forced deterministically on demand.
//  - The secondary (abuse-detection) 403 can only be produced by hammering
//    the API — which the docs explicitly warn against and which would be
//    abusive. Both are stable, documented shapes (github-api.md §1), so we
//    author them from the spec and mark provenance: 'synthetic'.

export function writeSyntheticFixtures(owner: string, repo: string): void {
  // GET /repos/{o}/{r}/stats/contributors → 202 while GitHub computes stats.
  // Body is empty; the client's contract is "202 → retry after a short delay,
  // then fall back to per-commit REST" (INGESTION.md §2/§8, W2-03).
  writeFixture({
    scenario: 'stats-contributors-202-warmup',
    provenance: 'synthetic',
    note: '202 stats-warmup — GitHub returns 202 with an empty body while it computes repository statistics; the ingest client retries then falls back to per-commit REST. Authored (cannot be forced live on a warm cache).',
    request: {
      method: 'GET',
      url: `https://api.github.com/repos/${owner}/${repo}/stats/contributors`,
    },
    response: {
      status: 202,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4998',
        'x-ratelimit-used': '2',
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-resource': 'core',
      },
      body: {},
    },
  });

  // Secondary rate-limit 403 — abuse detection. The client must honor
  // retry-after (backoff.ts secondaryLimitBackoffMs), never hammer.
  writeFixture({
    scenario: 'secondary-rate-limit-403',
    provenance: 'synthetic',
    note: 'Secondary (abuse-detection) 403 with retry-after — cannot be produced without abusing the API. The BudgetedClient honors retry-after (FORGE_PROVIDER §3). Authored from github-api.md §1.',
    request: { method: 'GET', url: 'https://api.github.com/repos/bpmforge/repopulse/commits' },
    response: {
      status: 403,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': '60',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4873',
        'x-ratelimit-used': '127',
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-resource': 'core',
      },
      body: {
        message:
          'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        documentation_url:
          'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api',
      },
    },
  });
}
