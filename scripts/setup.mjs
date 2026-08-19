#!/usr/bin/env node
// `pnpm bootstrap` — clone to a ready dev stack, in one command (W13-01).
//
// Why this exists: booting the API with nothing but .env.example fails twice.
// First `missing required env var GITHUB_APP_CLIENT_ID`, then `TOKEN_ENC_KEY is
// required (32-byte hex)`. Both blanks are CORRECT — a committed key is a
// published key (Law 9) — which means the documented setup file cannot start
// the app and never could. The fix is to GENERATE the secrets here rather than
// tell a newcomer to run `openssl rand -hex 32` twice and paste the results,
// which is the step everyone gets wrong.

import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[2m·\x1b[0m ${m}`);
const die = (title, fix) => {
  console.error(`\n\x1b[31m${title}\x1b[0m\n\n${fix}\n`);
  process.exit(1);
};

// Secrets this script generates when blank. NOT the GitHub ones: those identify
// a real OAuth app that only a human can register, and inventing a value would
// produce a stack trace at login instead of an honest "you have not set this".
const GENERATED = {
  SESSION_SECRET: () => randomBytes(32).toString('hex'),
  WEBHOOK_SECRET: () => randomBytes(32).toString('hex'),
  // 32 bytes of HEX specifically — credentials.loadTokenKey validates the
  // length at boot, so a wrong-sized value fails immediately rather than
  // writing credentials it can never decrypt.
  TOKEN_ENC_KEY: () => randomBytes(32).toString('hex'),
};

console.log('\nRepoPulse setup\n');

// ---- 1. Tools ---------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) die(`Node ${process.versions.node} is too old.`, '  RepoPulse needs Node 22+ (see .nvmrc).');
ok(`node ${process.versions.node}`);

let compose = null;
for (const [bin, args] of [['podman', ['compose', 'version']], ['docker', ['compose', 'version']]]) {
  try {
    execFileSync(bin, args, { stdio: 'ignore' });
    compose = bin;
    break;
  } catch {
    /* try the next one */
  }
}
if (!compose) {
  die(
    'Neither podman nor docker is available.',
    '  The dev data tier is Postgres 16 + Redis in containers.\n' +
      '    macOS:  brew install podman && podman machine init && podman machine start\n' +
      '    Linux:  install podman or docker from your distribution',
  );
}
ok(`${compose} compose`);

// ---- 2. .env ----------------------------------------------------------------
// Never clobber. A rerun that regenerates TOKEN_ENC_KEY silently makes every
// stored forge credential undecryptable (DEPLOYMENT.md §3) — the kind of damage
// that shows up weeks later as "why can we no longer sync".
if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  ok('.env created from .env.example');
} else {
  info('.env already exists — leaving it alone');
}

let env = readFileSync('.env', 'utf8');
const generated = [];
for (const [key, make] of Object.entries(GENERATED)) {
  const line = new RegExp(`^${key}=(.*)$`, 'm');
  const current = env.match(line)?.[1]?.trim();
  // Blank is not the only "unset". .env.example PRE-FILLS SESSION_SECRET and
  // WEBHOOK_SECRET with `dev-insecure-…` placeholders, so a fill-only-blanks
  // rule left every fresh install signing sessions and validating webhook
  // HMACs with a secret that is published in this repository — anyone could
  // forge a session cookie or a webhook delivery against a default install.
  // Placeholders count as unset; a real value is still never touched.
  const isPlaceholder = !current || /dev-insecure|REPLACE_WITH|changeme/i.test(current);
  if (!isPlaceholder) continue;
  const value = make();
  env = line.test(env) ? env.replace(line, `${key}=${value}`) : `${env}\n${key}=${value}\n`;
  generated.push(key);
}
if (generated.length > 0) {
  writeFileSync('.env', env);
  ok(`generated ${generated.join(', ')}`);
} else {
  info('secrets already set — none regenerated');
}

// ---- 3. Ports ---------------------------------------------------------------
const portFree = (port) =>
  new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(false));
    s.once('error', () => done(true));
    setTimeout(() => done(true), 700);
  });

const busy = [];
for (const [port, what] of [[5432, 'postgres'], [6379, 'redis']]) {
  if (!(await portFree(port))) busy.push(`${what} (:${port})`);
}
if (busy.length > 0) {
  // Not fatal: an already-running data tier is the normal case on a machine
  // that has done this before, and compose will simply reuse it.
  info(`already listening: ${busy.join(', ')} — assuming that is the dev data tier`);
}

// ---- 4. Data tier -----------------------------------------------------------
const run = (cmd, label) => {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch {
    die(`${label} failed.`, `  Command: ${cmd}\n  Fix the error above and run \`pnpm bootstrap\` again — it is safe to rerun.`);
  }
};

info('starting postgres + redis…');
run(`${compose} compose -f compose.dev.yaml up -d postgres redis`, 'Starting the data tier');
ok('data tier up');

// Wait for Postgres to actually accept connections. Compose returning is not
// the same as the database being ready, and migrating against a port that is
// open but not yet authenticating fails as a confusing connection error.
process.stdout.write('  · waiting for postgres…');
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  try {
    // `${compose} compose exec`, NOT `${compose} exec`: the service is called
    // `postgres` to compose but the CONTAINER is `repopulse-postgres`, and
    // plain `podman exec` has no -T. Getting this wrong reported "Postgres did
    // not become ready" against a database that had been healthy for six days.
    execSync(`${compose} compose -f compose.dev.yaml exec -T postgres pg_isready -U repopulse -d repopulse`, { stdio: 'ignore' });
    ready = true;
  } catch {
    // Blocking sleep without shelling out to `sleep`.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
}
console.log(ready ? '\r  \x1b[32m✓\x1b[0m postgres accepting connections' : '');
if (!ready) die('Postgres did not become ready.', `  Check: ${compose} logs repopulse-postgres`);

// ---- 5. Schema + data -------------------------------------------------------
info('applying migrations…');
run('pnpm db:migrate', 'Migration');
ok('schema up to date');

info('seeding demo data…');
run('pnpm seed', 'Seeding');
ok('warehouse seeded');

// ---- 6. What now ------------------------------------------------------------
const envNow = readFileSync('.env', 'utf8');
const hasGithub = /^GITHUB_APP_CLIENT_ID=.+$/m.test(envNow);

console.log(`\n\x1b[32mSetup complete.\x1b[0m\n`);
if (!hasGithub) {
  // Said plainly rather than left for them to discover at the login screen.
  console.log(
    `  One thing is still missing: GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET.\n` +
      `  They identify a GitHub OAuth app that only you can register, so setup\n` +
      `  cannot invent them.\n\n` +
      `    Just want to see it work?   DEMO_MODE=1 pnpm dev\n` +
      `    Connecting a real org?      see docs/RUNNING.md\n`,
  );
} else {
  console.log(`    pnpm dev      # api + worker + web\n`);
}
