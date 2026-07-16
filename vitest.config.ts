import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several test files exercise live Postgres/Redis (scripts/dev-up.sh)
    // and share mutable global state — the single `default` workspace's
    // membership table (FOUNDING_BRIEF D1). Running test files in parallel
    // workers risks cross-file races on that shared state (W1-04:
    // packages/auth/src/workspace/default-workspace.test.ts and
    // apps/api/src/plugins/api-v1.test.ts both touch it). Suite is small
    // enough that sequential file execution costs nothing meaningful.
    fileParallelism: false,
  },
});
