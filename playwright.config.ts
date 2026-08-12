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
  // Two servers: the e2e API (production buildApp + fake-GitHub boundary, see
  // e2e/server.ts) and the web dev server, whose /api and /auth proxy targets
  // are what make the API port matter. Order is not a dependency — Playwright
  // waits on both urls before the first test.
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : [
        {
          command: 'pnpm exec tsx e2e/server.ts',
          url: `http://localhost:${process.env.E2E_API_PORT ?? 3000}/healthz`,
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @repopulse/web dev',
          url: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
          // W4-11: point the dev proxy at whatever port the e2e API bound, so
          // one env var moves the whole stack. Without this the run only works
          // where 3000 is free, and W4-00 could only be verified through an
          // uncommitted edit — which is not a verification.
          env: { API_PROXY_TARGET: `http://localhost:${process.env.E2E_API_PORT ?? 3000}` },
          reuseExistingServer: false,
          timeout: 60_000,
        },
      ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
