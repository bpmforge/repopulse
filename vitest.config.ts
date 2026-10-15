import 'dotenv/config';
import { defineConfig } from 'vitest/config';
// @ts-expect-error -- plain .mjs helper shared with scripts/, no type declarations
import { useTestDatabase } from './scripts/test-db.mjs';

// W17-42: the suite runs against its own `<dev name>_test` database, never the
// one `.env` names — the seed reset wipes the Default workspace's connections
// and repos. This runs in the main process before any worker is spawned, and
// the workers inherit the rewritten DATABASE_URL; `dotenv/config` in the test
// files never overrides a variable that is already set. See scripts/test-db.mjs.
await useTestDatabase();

export default defineConfig({
  test: {
    // Projects live HERE rather than in vitest.workspace.ts (W16-17). The
    // workspace file is deprecated and prints a warning on every run, and
    // when it is removed in the next major the options below would have had
    // nowhere to apply from — which matters more than the warning does,
    // because one of them is load-bearing.
    projects: ['apps/*', 'packages/*', 'tools/repopulse-cli'],

    // Several test files exercise live Postgres/Redis (scripts/dev-up.sh)
    // and share mutable global state — the single `default` workspace's
    // membership table (FOUNDING_BRIEF D1). Running test files in parallel
    // workers risks cross-file races on that shared state (W1-04:
    // packages/auth/src/workspace/default-workspace.test.ts and
    // apps/api/src/plugins/api-v1.test.ts both touch it). Suite is small
    // enough that sequential file execution costs nothing meaningful.
    //
    // LOAD-BEARING, and verified rather than assumed (W16-17): a probe that
    // appended start/end timestamps from three files in three packages showed
    // no overlapping windows. It is also what keeps a second latent hazard
    // dormant — packages/auth accounts.test.ts and apps/api auth/local.test.ts
    // both delete every `users WHERE auth_provider = 'local'`, because the
    // bootstrap's idempotence rule is genuinely global. Sequential, that is
    // merely untidy. Parallel, it is a race.
    fileParallelism: false,
  },
});
