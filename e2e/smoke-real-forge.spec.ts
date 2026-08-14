import 'dotenv/config';
import { expect, test } from '@playwright/test';
import { loginAsFixture } from './helpers/auth.js';
import { waitForIngestedRepo } from './helpers/warehouse.js';

// REAL-FORGE SMOKE (founder-run, 2026-08-13).
//
// Every other spec proves the pipeline against a fake forge we wrote, which
// cannot tell us whether our understanding of GitHub is right — only that it is
// self-consistent. This is the one test that talks to api.github.com.
//
// Skipped unless SMOKE_FORGE_PAT is present, so a normal run and CI are
// unaffected. Requires the harness in real-forge mode:
//
//   SMOKE_REAL_FORGE=1 E2E_API_PORT=3011 pnpm e2e --grep "real forge"
//
// The login boundary stays faked (registering an OAuth app is unrelated
// friction); the FORGE boundary is real, which is the seam under test.

const PAT = process.env.SMOKE_FORGE_PAT;

// Public repos, chosen for shape rather than convenience: `quarry` is tiny (9
// commits, 0 PRs) so a break shows up in seconds, and `attest-claude` has real
// PR and review history so the enrichment lane is genuinely exercised.
const TARGETS = [
  { full: 'bpmforge/quarry', minCommits: 5 },
  { full: 'bpmforge/attest-claude', minCommits: 50 },
];

test.describe('real forge', () => {
  test.skip(!PAT, 'set SMOKE_FORGE_PAT in .env.smoke to run the real-forge smoke');

  test('ingests real repositories from api.github.com', async ({ page }) => {
    // Minutes, not seconds: one enrich job per commit against a live API under
    // the rate-limit budget.
    test.setTimeout(15 * 60_000);

    await loginAsFixture(page);
    await page.goto('/admin');
    await page.getByTestId('connection-credential').fill(PAT!);
    await page.getByTestId('connection-submit').click();
    await expect(page.getByTestId('connection-result')).toBeVisible({ timeout: 60_000 });

    // The picker lists what the credential can actually see — /user/repos, so
    // only repos this token has a real access relationship with. RepoPulse
    // cannot be pointed at an arbitrary third-party public repo.
    for (const target of TARGETS) {
      // By ROLE, not by testid+hasText: the testid is on the <input> and the
      // label text lives in a sibling <span>, so an input never "has text".
      // The accessible name comes from the wrapping <label>, which is exactly
      // "org/name".
      const option = page.getByRole('checkbox', { name: target.full, exact: true });
      await expect(option, `${target.full} should appear in the picker`).toBeVisible({
        timeout: 30_000,
      });
      await option.check();
    }

    await page.getByTestId('repo-select-submit').first().click();
    await expect(page.getByTestId('repo-select-result').first()).toBeVisible({ timeout: 60_000 });

    for (const target of TARGETS) {
      const [org, name] = target.full.split('/') as [string, string];
      const ingested = await waitForIngestedRepo(org, name, 12 * 60_000);

      // Lower bounds, not exact counts: unlike the fixture, a real repo's
      // contents change. What matters is that real data arrived and the state
      // machine ran to completion.
      expect(
        ingested.commits,
        `${target.full} should have ingested commits`,
      ).toBeGreaterThanOrEqual(target.minCommits);
      expect(ingested.commitFiles, `${target.full} should have churn`).toBeGreaterThan(0);
      expect(ingested.syncStatus, `${target.full} should reach live`).toBe('live');
    }
  });
});
