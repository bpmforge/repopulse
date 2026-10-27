// Loaded HERE, not just in globalSetup: webServer `env` blocks are built when
// this config is evaluated, which happens before globalSetup runs. Without it
// the worker starts with no DATABASE_URL/REDIS_URL — and since `pnpm --filter`
// gives it cwd=apps/api, its own dotenv/config finds no .env to recover from.
import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import { PORTS } from './ports.config.mjs';

// Playwright e2e (docs/TESTING.md §6). Runs against the compose dev stack
// (real API + DB, seeded by `pnpm seed`) with OAuth mocked at the boundary.
// The web dev server is auto-started unless E2E_NO_SERVER is set (CI may run it
// separately). Browsers install with `pnpm exec playwright install`.
// The fake forge must bind a KNOWN port: e2e/server.ts defaults it to 0
// (random), which is fine when only the in-process API talks to it, but the
// worker is a separate process and needs a URL up front. One constant feeds
// both.
const FAKE_FORGE_PORT = String(PORTS.e2eFakeForge);
// SMOKE_REAL_FORGE=1 points the API and the worker at api.github.com instead of
// the fake. The SC-12 loopback hatch is deliberately NOT set in that mode: it
// exists only so a loopback fake is reachable, and it must never be active
// while talking to a real host.
const REAL_FORGE = process.env.SMOKE_REAL_FORGE === '1';
const workerForgeEnv = REAL_FORGE
  ? {}
  : {
      FORGE_BASE_URL: `http://127.0.0.1:${FAKE_FORGE_PORT}`,
      FORGE_ALLOW_INSECURE_LOOPBACK: '1',
    };
const WORKER_HEALTH_PORT = String(PORTS.e2eWorkerHealth);

export default defineConfig({
  testDir: './e2e',
  // e2e/demo/ belongs to playwright.demo.config.ts (W16-14): it boots
  // `DEMO_MODE=1 pnpm dev` on its own ports and signs in through the form,
  // with no storageState. Run here it finds the e2e stack instead — no demo
  // banner, no pre-filled credentials — and fails for reasons that say nothing
  // about the demo. testDir alone does not exclude a subdirectory.
  // e2e/journey/ belongs to playwright.journey.config.ts (W17-30): it drives
  // the packaged demo stack on its own port and signs in as the bootstrap
  // admin. Same reasoning — run here it would find the wrong stack.
  testIgnore: ['demo/**', 'journey/**'],
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  fullyParallel: false,
  // `fullyParallel: false` only serializes tests WITHIN a file — Playwright
  // still runs different files on parallel workers, and this suite was running
  // 49 tests on 9 of them while its own comment claimed it was serialized.
  //
  // Every spec shares one seeded warehouse and one fixture user, so that was a
  // latent race, not a fast suite: W4-10 nulls the fixture's persona to test
  // the first-login picker, and six unrelated specs in other files timed out
  // behind the modal that appeared over their screens. Any spec that mutates
  // shared state would have done the same. workers: 1 is what the comment
  // always meant (verified: 38s -> ~60s, and the flake is gone).
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORTS.web}`,
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
          url: `http://localhost:${PORTS.e2eApi}/healthz`,
          // Spread process.env: Playwright REPLACES the environment rather than
          // extending it, so an `env` block silently drops DATABASE_URL et al.
          env: {
            ...process.env,
            // Explicit, so the API under test binds the e2e port even when the
            // shell has no E2E_API_PORT set — the whole point of moving these
            // defaults into ports.config.mjs.
            E2E_API_PORT: String(PORTS.e2eApi),
            E2E_FAKE_FORGE_PORT: FAKE_FORGE_PORT,
            ...(REAL_FORGE ? { SMOKE_FORGE_BASE_URL: 'https://api.github.com' } : {}),
            // The connect route applies the worker's SC-12 check, so the API
            // needs the same loopback hatch to accept the http fake forge.
            ...(REAL_FORGE ? {} : { FORGE_ALLOW_INSECURE_LOOPBACK: '1' }),
          },
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
            // No nightly sweep during tests. The seeder creates `live` repos,
            // so a firing sweep re-lists every entity for every one of them
            // mid-run — work no test asked for, against a fake forge, on the
            // same database the suite is asserting against.
            RECONCILE_CRON: 'off',
            PLANS_VERIFY_CRON: 'off',
            ...workerForgeEnv,
          },
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @repopulse/web dev',
          url: process.env.E2E_BASE_URL ?? `http://localhost:${PORTS.web}`,
          // W4-11: point the dev proxy at whatever port the e2e API bound, so
          // one env var moves the whole stack. Without this the run only works
          // where 3000 is free, and W4-00 could only be verified through an
          // uncommitted edit — which is not a verification.
          env: { API_PROXY_TARGET: `http://localhost:${PORTS.e2eApi}` },
          reuseExistingServer: false,
          timeout: 60_000,
        },
      ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
