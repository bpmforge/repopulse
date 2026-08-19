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
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const PROCS = [
  { name: 'api', color: '\x1b[36m', cmd: 'pnpm', args: ['--filter', '@repopulse/api', 'dev'], port: Number(process.env.PORT ?? 3000) },
  { name: 'worker', color: '\x1b[35m', cmd: 'pnpm', args: ['--filter', '@repopulse/api', 'dev:worker'] },
  { name: 'web', color: '\x1b[32m', cmd: 'pnpm', args: ['--filter', '@repopulse/web', 'dev'], port: 5173 },
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
const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'API_BASE_URL', 'PUBLIC_BASE_URL', 'TOKEN_ENC_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET'];
const missingEnv = REQUIRED.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(
    `\nThe API cannot start — missing: ${missingEnv.join(', ')}\n\n` +
      `  Fresh clone?   pnpm bootstrap            # writes .env and generates the secrets\n` +
      `  No GitHub app? DEMO_MODE=1 pnpm dev  # seeded demo data, no GitHub account\n\n` +
      `  These live in .env at the REPO ROOT (not apps/api/.env).\n`,
  );
  process.exit(1);
}

// Preflight every port first. Starting the stack and letting the third process
// die on EADDRINUSE leaves two orphans running and a confusing error; a compose
// dev stack already holds 3000 on at least one machine here, which is exactly
// what E2E_API_PORT exists to work around.
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
      `    PORT=3010 pnpm dev        # or move the API out of the way\n`,
  );
  process.exit(1);
}

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
  `\n  api    http://localhost:${PROCS[0].port}\n` +
    `  web    http://localhost:5173\n` +
    `  worker (ingestion queues)\n\n` +
    `  Ctrl-C stops all three.\n`,
);
