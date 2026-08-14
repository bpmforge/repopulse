// Loaded HERE, not just in globalSetup: webServer `env` blocks are built when
// this config is evaluated, which happens before globalSetup runs. Without it
// the worker starts with no DATABASE_URL/REDIS_URL — and since `pnpm --filter`
// gives it cwd=apps/api, its own dotenv/config finds no .env to recover from.
import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

// Playwright e2e (docs/TESTING.md §6). Runs against the compose dev stack
// (real API + DB, seeded by `pnpm seed`) with OAuth mocked at the boundary.
// The web dev server is auto-started unless E2E_NO_SERVER is set (CI may run it
// separately). Browsers install with `pnpm exec playwright install`.
// The fake forge must bind a KNOWN port: e2e/server.ts defaults it to 0
// (random), which is fine when only the in-process API talks to it, but the
// worker is a separate process and needs a URL up front. One constant feeds
// both.
const FAKE_FORGE_PORT = process.env.E2E_FAKE_FORGE_PORT ?? '9099';
const WORKER_HEALTH_PORT = process.env.E2E_WORKER_HEALTH_PORT ?? '3098';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false, // shared seeded warehouse — serialize like the vitest suite
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    // Session established once in globalSetup — see the SC-11 note there.
    storageState: 'e2e/.auth/state.json',
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
          // Spread process.env: Playwright REPLACES the environment rather than
          // extending it, so an `env` block silently drops DATABASE_URL et al.
          env: { ...process.env, E2E_FAKE_FORGE_PORT: FAKE_FORGE_PORT },
          reuseExistingServer: false,
          timeout: 60_000,
        },
        // The ingestion worker. Without it the queues fill and nothing drains,
        // so every "did ingestion write anything?" assertion could only ever be
        // checked by hand — which is precisely how five separate pieces of this
        // codebase reached "done" while wired to nothing. It runs the SHIPPING
        // entrypoint (src/workers/index.ts), not a test double.
        {
          command: 'pnpm --filter @repopulse/api exec tsx src/workers/index.ts',
          url: `http://localhost:${WORKER_HEALTH_PORT}/healthz`,
          // Spread process.env — see the note above; and `pnpm --filter` runs
          // with cwd=apps/api, where dotenv finds no .env to fall back on.
          env: {
            ...process.env,
            WORKER_HEALTH_PORT,
            FORGE_BASE_URL: `http://127.0.0.1:${FAKE_FORGE_PORT}`,
            // SC-12: loopback-only, operator-set. See ValidateBaseUrlOptions.
            FORGE_ALLOW_INSECURE_LOOPBACK: '1',
          },
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
