#!/usr/bin/env node
// `pnpm dev` — the whole local stack in one command (W13-03).
//
// Three processes, not two. apps/api/src/workers/index.ts is the ingestion
// worker, and until this script existed NOTHING in any package.json started
// it: the only thing that ever launched it was playwright.config.ts's
// webServer block. A developer running the API alone gets queues that fill and
// never drain, which reads as "ingestion is broken" rather than "ingestion was
// never running" — the same silent-inertness this project has now caught eight
// times.
//
// No new dependency: spawning three children and prefixing their output is
// less code than wiring a process-runner library, and it keeps the shutdown
// semantics ours (see below).

// Loaded HERE, in the parent, and inherited by all three children. `pnpm
// --filter` runs each child with cwd=apps/api or apps/web, so a child's own
// `import 'dotenv/config'` looks for .env in THAT directory and finds nothing —
// the API died on `missing required env var DATABASE_URL` and the worker on
// `DATABASE_URL and REDIS_URL are required`, on a machine where .env exists and
// every other entrypoint works. playwright.config.ts carries the same note for
// the same reason.
import 'dotenv/config';
import { PORTS, urlFor } from '../ports.config.mjs';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

// DEMO_MODE swaps the API entrypoint for the demo one (W13-02): a fake forge,
// a mocked login boundary and a seeded warehouse, so the whole product runs
// with no GitHub account and no registered OAuth app. Explicit falsey spellings
// count as OFF — `DEMO_MODE=0` reading as ON is how a demo login ends up in
// front of real data.
const DEMO = (() => {
  const f = process.env.DEMO_MODE;
  return f !== undefined && f !== '' && f !== '0' && f.toLowerCase() !== 'false';
})();

const PROCS = [
  { name: 'api', color: '\x1b[36m', cmd: 'pnpm', args: ['--filter', '@repopulse/api', DEMO ? 'demo' : 'dev'], port: PORTS.api },
  { name: 'worker', color: '\x1b[35m', cmd: 'pnpm', args: ['--filter', '@repopulse/api', 'dev:worker'] },
  { name: 'web', color: '\x1b[32m', cmd: 'pnpm', args: ['--filter', '@repopulse/web', 'dev'], port: PORTS.web },
];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/** True when something is already listening — checked BEFORE anything starts. */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 700);
  });
}

// Required-env preflight, for the same reason as the port check: the API
// throws `missing required env var GITHUB_APP_CLIENT_ID` from inside a tsx
// child, which arrives as a stack trace interleaved with two other processes'
// output. On a fresh clone this is the FIRST thing a newcomer hits, and a
// stack trace does not tell them the fix is `pnpm bootstrap` (W13-01) or demo mode
// (W13-02).
// GITHUB_APP_* IS NOT HERE, and its absence is the point (W16-18).
//
// This list demanded it in non-demo mode, which made `pnpm dev` refuse to start
// on any install without a GitHub App — while D14 had already made forge
// sign-in optional and THREE other places said so: env-registry marks both
// `required: false` ("OPTIONAL since D14"), apps/api/src/index.ts handles their
// absence explicitly ("when both are absent, forge sign-in is simply not
// offered"), and docs/RUNNING.md promises "their absence is no longer fatal".
//
// Only this launcher still disagreed, and it is the launcher the docs tell
// people to run — so the entire "install without a forge account" outcome that
// D14 and W15-05 delivered was unreachable through the documented command. It
// went unnoticed because nothing ever booted the non-demo path: every test and
// every manual pass used DEMO_MODE, which skipped this branch.
//
// The drift gate in apps/api/test/ops/dev-required-env.test.ts now compares this
// list to ENV_REGISTRY, so the two cannot disagree again.
const REQUIRED = [
  'DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'API_BASE_URL', 'PUBLIC_BASE_URL', 'TOKEN_ENC_KEY',
];
const missingEnv = REQUIRED.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(
    `\nThe API cannot start — missing: ${missingEnv.join(', ')}\n\n` +
      `  Fresh clone?   pnpm bootstrap            # writes .env and generates the secrets\n` +
      `  Just looking?  DEMO_MODE=1 pnpm dev  # seeded demo data, no account at all\n\n` +
      `  These live in .env at the REPO ROOT (not apps/api/.env).\n`,
  );
  process.exit(1);
}

// Preflight every port first. Starting the stack and letting the third process
// die on EADDRINUSE leaves two orphans running and a confusing error.
//
// The ports themselves live in ports.config.mjs, deliberately outside the
// framework defaults: 5173, 3000 and 3001 are what every other project on a
// machine also picks, and sharing a machine with one is enough to lose an e2e
// run to a port conflict.
const taken = [];
for (const p of PROCS) {
  if (p.port && (await portInUse(p.port))) taken.push(`${p.name} (:${p.port})`);
}
if (taken.length > 0) {
  console.error(
    `\nPort already in use: ${taken.join(', ')}\n\n` +
      `  Something is already listening. Common cause: the deploy/compose.yaml\n` +
      `  stack, or a previous \`pnpm dev\` that did not shut down.\n\n` +
      `    podman ps                 # see what is running\n` +
      `    PORT=3320 pnpm dev        # or move the API out of the way\n`,
  );
  process.exit(1);
}

// The web dev server proxies /api and /auth to API_PROXY_TARGET, which
// defaults to the api port. So `PORT=3320 pnpm dev` — the workaround this script
// itself prints on a port conflict — moved the API but left the browser
// talking to whatever was still on 3000. Found by running the documented
// quickstart on a clean clone (W13-05). Setting it from PORT here makes the
// advice true; an explicit API_PROXY_TARGET still wins.
process.env.API_PROXY_TARGET ??= `http://localhost:${PROCS[0].port}`;

const children = [];
let shuttingDown = false;

for (const p of PROCS) {
  const child = spawn(p.cmd, p.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push({ ...p, child });

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      console.log(`${p.color}${p.name.padEnd(6)}${RESET} ${DIM}|${RESET} ${line}`);
    });
  }

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // One process dying takes the stack down. Leaving the other two up would
    // present as a half-working app — the exact failure mode that makes people
    // think ingestion is broken when the worker simply is not there.
    console.error(`\n${p.color}${p.name}${RESET} exited (${signal ?? `code ${code}`}) — stopping the stack.`);
    shutdown(code ?? 1);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  // Anything still alive after the grace period gets SIGKILL, so Ctrl-C never
  // leaves an orphan holding a port that the next `pnpm dev` will trip over.
  setTimeout(() => {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(code);
  }, 3000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

console.log(
  (DEMO ? `\n  \x1b[33mDEMO MODE\x1b[0m — fake forge, mocked sign-in, seeded data\n` : '') +
    `\n  api    http://localhost:${PROCS[0].port}\n` +
    `  web    ${urlFor('web')}\n` +
    `  worker (ingestion queues)\n\n` +
    `  Ctrl-C stops all three.\n`,
);
