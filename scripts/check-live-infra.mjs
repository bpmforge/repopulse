#!/usr/bin/env node
// Live-infra preflight for the unit gate (W12-08).
//
// 37 test files gate themselves on live Postgres + Redis with a locally
// declared `const describeIfLiveInfra = databaseUrl && redisUrl ? describe :
// describe.skip`. Without a data tier they become `describe.skip`, and
// `pnpm test` exits 0.
//
// The skip is NOT invisible — vitest prints `Test Files 85 passed | 37 skipped`
// — so this script does not reinvent that count as a reporter. What was missing
// is ENFORCEMENT: CI reads the exit code, not the summary line, and
// .github/workflows/ci.yml provisions neither service, so every green check on
// this repo has covered 433 of 586 tests without ever saying so.
//
// Two modes, on purpose:
//   REQUIRE_LIVE_INFRA set  -> a missing service FAILS before any test runs.
//   unset                   -> the run proceeds, with a warning naming the cost.
//
// Unconditional failure was considered and rejected: CI has no data tier yet
// (W12-10 adds one and sets the flag), and shipping a permanently-red gate to
// replace a dishonest one is not an improvement.

import 'dotenv/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['apps', 'packages'];
const MARKER = 'describeIfLiveInfra';

/** Test files that gate themselves on live infra — counted, not assumed. */
function gatedTestFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      gatedTestFiles(path, found);
    } else if (/\.test\.ts$/.test(entry) && readFileSync(path, 'utf8').includes(MARKER)) {
      found.push(path);
    }
  }
  return found;
}

const missing = ['DATABASE_URL', 'REDIS_URL'].filter((v) => !process.env[v]);
const required = !!process.env.REQUIRE_LIVE_INFRA;

if (missing.length === 0) {
  process.exit(0);
}

const gated = ROOTS.flatMap((r) => gatedTestFiles(r));
const list = gated.map((f) => `    ${f}`).join('\n');

if (required) {
  console.error(
    `\nREQUIRE_LIVE_INFRA is set, but ${missing.join(' and ')} ${
      missing.length > 1 ? 'are' : 'is'
    } not.\n\n` +
      `  ${gated.length} test files would silently skip:\n${list}\n\n` +
      `  Start the data tier with scripts/dev-up.sh, or unset REQUIRE_LIVE_INFRA\n` +
      `  to run the offline subset knowingly.\n`,
  );
  process.exit(1);
}

console.warn(
  `\nWARNING: ${missing.join(' and ')} unset — ${gated.length} test files will SKIP.\n` +
    `  This run does NOT cover the admin, workspace-settings, tenancy, security-header,\n` +
    `  rate-limit, audit-log, snapshot, backfill, reconcile, DLQ or seed suites.\n` +
    `  A green result here is green over a subset. Run scripts/dev-up.sh for the rest,\n` +
    `  or set REQUIRE_LIVE_INFRA=1 to make this a failure.\n`,
);
