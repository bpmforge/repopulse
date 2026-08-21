#!/usr/bin/env node
// Live-infra preflight for the unit gate (W12-08).
//
// A number of test files gate themselves on live Postgres + Redis with a
// locally declared `const describeIfLiveInfra = databaseUrl && redisUrl ?
// describe : describe.skip`. Without a data tier they become `describe.skip`,
// and `pnpm test` exits 0. How many is COUNTED AT RUNTIME from the source
// marker below — it was 37 when W12-08 wrote this and is 61 today, which is
// exactly why no figure is hardcoded in this comment.
//
// The skip is NOT invisible — vitest prints its own `N skipped` — so this
// script does not reinvent that count as a reporter. What was missing is
// ENFORCEMENT: CI reads the exit code, not the summary line, and
// .github/workflows/ci.yml provisions neither service, so every green check on
// this repo has covered a subset without ever saying so.
//
// Two modes, on purpose:
//   REQUIRE_LIVE_INFRA set  -> a missing service FAILS before any test runs.
//   unset                   -> the run proceeds, with a warning naming the cost.
//
// Unconditional failure was considered and rejected: CI has no data tier yet
// (W12-10 adds one and sets the flag), and shipping a permanently-red gate to
// replace a dishonest one is not an improvement.
//
// A SET variable pointing at a DEAD service is a third case, and until the
// probe below it was indistinguishable from a healthy one: the vars come from
// `.env`, so a stopped data tier still passed this preflight and the gated
// files then RAN and FAILED, 40 ECONNREFUSED stack traces and ~200s later.
// That is the same red, minus the cause. The probe fails it in two seconds
// with the address named.
//
// This cannot resurrect the permanently-red gate W12-08 rejected: the probe
// only runs against variables that are SET, and the documented offline run
// (`DOTENV_CONFIG_PATH=/dev/null pnpm test`) leaves both UNSET, taking the
// warn-and-proceed path above.
//
// SCOPE, deliberately: a TCP connect proves something is LISTENING, not that
// Postgres will answer a query — a container still in `Up (starting)` passes
// it. Readiness needs a handshake, which needs a client, which does not belong
// in a preflight. The failure text says "nothing is listening", not "the
// service is down", because that is what was measured.

import 'dotenv/config';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

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

/** Scheme -> port, because `new URL()` reports an absent port as ''. */
const DEFAULT_PORTS = { 'postgres:': 5432, 'postgresql:': 5432, 'redis:': 6379, 'rediss:': 6379 };
const PROBE_TIMEOUT_MS = 2000;

/**
 * Resolve the host:port a connection string actually points at. Returned as a
 * string for the failure message: the address we TRIED is the whole diagnostic
 * value here, and CI's vars will not look like a dev machine's.
 */
function addressOf(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1';
  const port = Number(url.port) || DEFAULT_PORTS[url.protocol];
  return { host, port, label: `${host}:${port ?? '?'}` };
}

/** Resolves true iff something accepts a TCP connection. Never throws. */
function listening({ host, port }) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Both vars are set. Fail — unconditionally, REQUIRE_LIVE_INFRA or not —
 * if nothing is listening: the gated files do not skip in this case, they run
 * and fail, so proceeding buys nothing but a slower, less legible red.
 */
async function checkReachable() {
  const targets = [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['REDIS_URL', process.env.REDIS_URL],
  ];

  const dead = [];
  for (const [name, value] of targets) {
    let address;
    try {
      address = addressOf(value);
    } catch {
      dead.push(`    ${name} is not a URL this script can parse: ${value}`);
      continue;
    }
    if (!(await listening(address))) dead.push(`    ${name} -> nothing is listening on ${address.label}`);
  }

  if (dead.length === 0) return;

  console.error(
    `\nThe data tier is unreachable:\n\n${dead.join('\n')}\n\n` +
      `  These variables are SET, so the gated suites will not skip —\n` +
      `  they will run and fail with ECONNREFUSED. Failing now instead.\n\n` +
      `  Start the data tier with scripts/dev-up.sh (which will start the Podman\n` +
      `  VM first if it is down — a crashed VM, not a stopped container, is the\n` +
      `  usual cause), or run the offline subset knowingly with\n` +
      `  DOTENV_CONFIG_PATH=/dev/null pnpm test.\n\n` +
      `  NOTE: this is a TCP connect. It proves something is listening, not that\n` +
      `  the service is ready to answer queries.\n`,
  );
  process.exit(1);
}

const missing = ['DATABASE_URL', 'REDIS_URL'].filter((v) => !process.env[v]);
const required = !!process.env.REQUIRE_LIVE_INFRA;

if (missing.length === 0) {
  await checkReachable();
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
