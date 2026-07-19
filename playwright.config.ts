import { defineConfig, devices } from '@playwright/test';

// Playwright e2e (docs/TESTING.md §6). Runs against the compose dev stack
// (real API + DB, seeded by `pnpm seed`) with OAuth mocked at the boundary.
// The web dev server is auto-started unless E2E_NO_SERVER is set (CI may run it
// separately). Browsers install with `pnpm exec playwright install`.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false, // shared seeded warehouse — serialize like the vitest suite
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: 'pnpm --filter @repopulse/web dev',
        url: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 60_000,
      },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
