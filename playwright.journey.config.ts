import { defineConfig, devices, type ReporterDescription } from '@playwright/test';

// The CUSTOMER JOURNEY, against a stack this config does not start (W17-30).
//
// deploy/journey.sh resets the demo stack, brings it up with the fixture-model
// overlay and then runs this. There is deliberately no webServer block: the
// thing under test is the packaged product on its own port, not a dev server,
// and starting anything here would make the run prove a different stack from
// the one a newcomer boots.
//
// No storageState either. The first screen of the journey IS the sign-in form
// and the forced password change behind it; a pre-authenticated context would
// skip the part of the product an install meets first.
//
// One serial file. The steps depend on each other in the way a real first run
// does — nothing to scan until something is ingested, no timeout drill until a
// model is configured — so a failure stops the run rather than letting later
// steps pass against state an earlier one never created.

const BASE_URL = process.env.JOURNEY_BASE_URL ?? 'http://localhost:8090';
const EVIDENCE_DIR = process.env.JOURNEY_EVIDENCE_DIR;

const reporter: ReporterDescription[] = [['list']];
if (EVIDENCE_DIR) {
  reporter.push(['json', { outputFile: `${EVIDENCE_DIR}/playwright-results.json` }]);
}

export default defineConfig({
  testDir: './e2e/journey',
  // Minutes, not seconds: one step waits for a real backfill, another waits out
  // the five-minute "nobody picked this job up" timer on purpose.
  timeout: 12 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
