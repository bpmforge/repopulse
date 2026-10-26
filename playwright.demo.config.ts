// Loaded HERE, not just in a setup file: webServer `env` blocks are built when
// this config is evaluated. See playwright.config.ts for the full note.
import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import { PORTS } from './ports.config.mjs';

// The DEMO quickstart, under test (W16-14).
//
// This is the gap that let three separate demo-mode bugs ship in one wave:
// a forge credential the vault could not decrypt (W16-28), a worker that sent
// that credential to the real api.github.com (W16-29), and a fake forge with
// no archive endpoint (W16-30). None of them was catchable, because nothing
// anywhere booted apps/api/src/demo.ts — e2e/server.ts is a different
// entrypoint, and every spec in the main suite authenticates through the
// mocked OAuth boundary with a storageState written by globalSetup. The screen
// a newcomer actually meets had no coverage at all.
//
// A SEPARATE CONFIG rather than a project in the main one, because Playwright
// attaches webServer to the config and not to the project: folding these in
// would boot a whole second stack on every ordinary e2e run.
//
// It runs `DEMO_MODE=1 pnpm dev` — the literal command in the README — rather
// than the API alone. scripts/dev.mjs is where the demo's forge wiring lives
// (W16-29 was a bug IN that file), so a test that started the API directly
// would skip the part that broke.

const API_PORT = String(PORTS.demoE2eApi);
const WEB_PORT = String(PORTS.demoE2eWeb);
const WEB_URL = `http://localhost:${PORTS.demoE2eWeb}`;

export default defineConfig({
  testDir: './e2e/demo',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    // NO storageState, unlike the main suite. Signing in through the form is
    // the thing being tested — a pre-authenticated context would walk straight
    // past the screen this project exists to cover.
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'node scripts/dev.mjs',
      url: WEB_URL,
      // Playwright REPLACES the environment rather than extending it, so the
      // spread is what keeps DATABASE_URL and TOKEN_ENC_KEY reachable.
      env: {
        ...process.env,
        DEMO_MODE: '1',
        PORT: API_PORT,
        WEB_PORT,
        PUBLIC_BASE_URL: WEB_URL,
        WORKER_HEALTH_PORT: String(PORTS.demoE2eWorkerHealth),
        DEMO_FORGE_PORT: String(PORTS.demoE2eFakeForge),
        // No sweep firing mid-run against the fixture the assertions read.
        RECONCILE_CRON: 'off',
        PLANS_VERIFY_CRON: 'off',
        SECRETS_HISTORY_CRON: 'off',
        SECURITY_WEEKLY_CRON: 'off',
      },
      reuseExistingServer: false,
      // Generous: demo.ts reseeds the whole warehouse (~1.5k snapshot rows)
      // before it binds, and three processes start behind this one URL.
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
