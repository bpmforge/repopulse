#!/usr/bin/env node
// `deploy/configure.sh` — write deploy/.env for a customer install (W17-05).
//
// WHY THIS IS NOT `cp .env.example .env`.
//
// The example cannot start the product, on purpose: SESSION_SECRET,
// TOKEN_ENC_KEY, WEBHOOK_SECRET, POSTGRES_PASSWORD and REDIS_PASSWORD all ship
// BLANK, because a committed secret is a published secret (CLAUDE.md law 9).
// So the documented first step leaves the operator running `openssl rand -hex
// 32` five times and hand-editing two connection URLs to match two of the
// passwords they just generated. That is the step people get wrong, and getting
// it wrong produces "TOKEN_ENC_KEY is required (32-byte hex)" at boot, or worse,
// credentials encrypted under a key that will not survive the next edit.
//
// WHY IT IS SELF-CONTAINED (no imports from the workspace).
//
// It has to run on a customer host that has NO Node and NO pnpm, via
// deploy/configure.sh, which executes it inside the migrate image with
// `--entrypoint node`. Only the deployment directory is mounted. Nothing from
// apps/ or packages/ is reachable, so the required-variable list is duplicated
// here — and apps/api/test/ops/deploy-configure.test.ts fails the build if that
// copy ever drifts from ENV_REGISTRY, which stays the single source of truth.
//
// scripts/setup.mjs is the DEVELOPER equivalent (`pnpm bootstrap`, a dev stack
// from a checkout). Deliberately separate: this one never touches a dev .env,
// never starts anything, and knows about compose service names rather than
// localhost ports.

import { randomBytes } from 'node:crypto';
import { existsSync, openSync, readFileSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';

const DEPLOY_DIR = process.env.REPOPULSE_DEPLOY_DIR ?? path.dirname(new URL(import.meta.url).pathname);
const ENV_PATH = path.join(DEPLOY_DIR, '.env');
const EXAMPLE_PATH = path.join(DEPLOY_DIR, '.env.example');

const red = (m) => `\x1b[31m${m}\x1b[0m`;
const dim = (m) => `\x1b[2m${m}\x1b[0m`;
const green = (m) => `\x1b[32m${m}\x1b[0m`;

function die(title, fix) {
  console.error(`\n${red(title)}\n\n${fix}\n`);
  process.exit(1);
}

// ----------------------------------------------------------------- args -----
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) die(`Unrecognised argument: ${arg}`, usage());
    out[m[1]] = m[2] ?? true;
  }
  return out;
}

function usage() {
  return `  Usage:
    deploy/configure.sh --url=https://repopulse.example.com [--port=8099] [--admin-email=you@example.com]

  Options:
    --url           REQUIRED. The address your users will open.
    --port          Host port the web tier publishes on (default 8099).
    --bind          Host interface to publish on (default 127.0.0.1).
    --admin-email   First administrator. Their password is read from
                    ADMIN_PASSWORD in the environment, or from
                    deploy/admin-password (deleted after it is read).
    --force-regenerate-secrets
                    Refuse-proof: only meaningful with no existing .env.`;
}

// ------------------------------------------------------------ validation ----
// Mirrors apps/api/src/routes/setup/env-registry.ts. The drift gate is
// apps/api/test/ops/deploy-configure.test.ts.
const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'SESSION_SECRET',
  'TOKEN_ENC_KEY',
  'API_BASE_URL',
  'PUBLIC_BASE_URL',
];

function validateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return `must be a valid absolute URL (got: ${value})`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `must be an http:// or https:// URL (got: ${url.protocol}//)`;
  }
  return null;
}

function validatePort(value) {
  if (!/^\d+$/.test(String(value))) return `must be a number (got: ${value})`;
  const n = Number(value);
  if (n < 1 || n > 65535) return `must be between 1 and 65535 (got: ${n})`;
  if (n < 1024) {
    return `${n} is a privileged port; containers here run rootless. Pick 1024 or above.`;
  }
  return null;
}

// --------------------------------------------------------------- secrets ----
// 32 bytes of hex specifically: credentials.loadTokenKey validates the length at
// boot, so a wrong-sized value fails immediately rather than writing credentials
// it can never decrypt.
const hex32 = () => randomBytes(32).toString('hex');
const hex24 = () => randomBytes(24).toString('hex');

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage());
    return;
  }

  // ---- refuse to touch an existing install --------------------------------
  //
  // Rewriting .env would rotate TOKEN_ENC_KEY, and every forge credential in the
  // database is encrypted under the old one. That is not a config change, it is
  // silent data loss: every connected organisation would have to be
  // re-authorised, and nothing would say why.
  if (existsSync(ENV_PATH)) {
    console.log(`\n${green('deploy/.env already exists')} — leaving it exactly as it is.\n`);
    console.log(`  Nothing was changed. To adjust this install, edit the file directly:`);
    console.log(dim(`      ${ENV_PATH}\n`));
    console.log(`  Its secrets are deliberately NOT regenerated. Rotating TOKEN_ENC_KEY`);
    console.log(`  makes every stored forge credential undecryptable, and every connected`);
    console.log(`  organisation would have to be re-authorised.\n`);
    console.log(`  To start over from nothing, move the old file aside first:`);
    console.log(dim(`      mv deploy/.env deploy/.env.backup\n`));
    return;
  }

  if (!existsSync(EXAMPLE_PATH)) {
    die('deploy/.env.example is missing.', '  This bundle is incomplete — re-extract it.');
  }

  // ---- required input ------------------------------------------------------
  const publicUrl = typeof args.url === 'string' ? args.url : undefined;
  if (!publicUrl) {
    die('--url is required.', usage());
  }
  const urlError = validateUrl(publicUrl);
  if (urlError) die(`--url ${urlError}`, usage());

  const port = args.port ?? '8099';
  const portError = validatePort(port);
  if (portError) die(`--port ${portError}`, usage());

  const bind = typeof args.bind === 'string' ? args.bind : '127.0.0.1';

  // ---- the first administrator (D14) --------------------------------------
  //
  // No universal default password, ever: a shipped default is the same password
  // on every install on the internet. The password comes from the environment or
  // a file the operator wrote, never from an argument (which would land in shell
  // history and `ps`).
  const adminEmail = typeof args['admin-email'] === 'string' ? args['admin-email'] : '';
  let adminPassword = process.env.ADMIN_PASSWORD ?? '';
  const pwFile = path.join(DEPLOY_DIR, 'admin-password');
  if (!adminPassword && existsSync(pwFile)) {
    adminPassword = readFileSync(pwFile, 'utf8').trim();
  }
  if (adminEmail && !adminPassword) {
    die(
      '--admin-email was given but no password was supplied.',
      `  Provide it WITHOUT putting it in your shell history:

      printf '%s' 'your-password-here' > deploy/admin-password
      deploy/configure.sh --url=${publicUrl} --admin-email=${adminEmail}

  or export ADMIN_PASSWORD in the environment. Minimum 12 characters.`,
    );
  }
  if (adminPassword && adminPassword.length < 12) {
    die(
      `The administrator password is too short (${adminPassword.length} characters).`,
      '  Minimum is 12. The account must change it at first sign-in regardless.',
    );
  }
  if (adminPassword && !adminEmail) {
    die('A password was supplied but --admin-email was not.', usage());
  }

  // ---- build the file ------------------------------------------------------
  const pgPassword = hex24();
  const redisPassword = hex24();

  const values = {
    POSTGRES_PASSWORD: pgPassword,
    REDIS_PASSWORD: redisPassword,
    // Service names, not localhost: the app reaches the data tier across the
    // compose network, and these are not published to the host at all.
    DATABASE_URL: `postgres://repopulse:${pgPassword}@postgres:5432/repopulse`,
    REDIS_URL: `redis://:${redisPassword}@redis:6379`,
    PUBLIC_BASE_URL: publicUrl,
    API_BASE_URL: publicUrl,
    REPOPULSE_PORT: String(port),
    REPOPULSE_BIND: bind,
    SESSION_SECRET: hex32(),
    TOKEN_ENC_KEY: hex32(),
    WEBHOOK_SECRET: hex32(),
    // W17-27: the worker → scan-runner bearer token. Per install, like the rest.
    SCAN_RUNNER_TOKEN: hex32(),
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
  };

  // Start from the example so every comment, and every variable we do NOT set,
  // survives verbatim. A generated file that drops the explanations is a file
  // the operator cannot edit later.
  const lines = readFileSync(EXAMPLE_PATH, 'utf8').split('\n');
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (!m) return line;
    const key = m[1];
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }

  const body = `${out.join('\n').replace(/\n+$/, '')}\n`;

  // Validate what we are about to write, before writing it — the same check the
  // API runs at boot, so a bad file is never created rather than created and
  // then rejected by a container that exits.
  const parsed = Object.fromEntries(
    body
      .split('\n')
      .map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
  const missing = REQUIRED.filter((k) => !parsed[k]);
  if (missing.length) {
    die(
      `Refusing to write an unusable deploy/.env — missing: ${missing.join(', ')}`,
      '  This is a bug in configure.mjs, not in your input. Please report it.',
    );
  }

  // Exclusive creation (wx) closes the race between the existsSync above and the
  // write: two operators running this at once must not both think they created
  // the install. 0600 because the file holds every secret this deployment has.
  let fd;
  try {
    fd = openSync(ENV_PATH, 'wx', 0o600);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      die(
        'deploy/.env appeared while this ran — nothing was written.',
        '  Another configure is probably running. Check the file, then retry.',
      );
    }
    throw e;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }

  // Never print a generated secret. Someone is always sharing this terminal, and
  // a scrollback with TOKEN_ENC_KEY in it is a compromised install.
  console.log(`\n${green('Wrote deploy/.env')} ${dim('(mode 0600)')}\n`);
  console.log(`  URL:   ${publicUrl}`);
  console.log(`  Port:  ${bind}:${port}`);
  console.log(`  Admin: ${adminEmail || dim('not set — see docs/INSTALL.md before first sign-in')}`);
  console.log(`\n  Generated: POSTGRES_PASSWORD, REDIS_PASSWORD, SESSION_SECRET,`);
  console.log(`             TOKEN_ENC_KEY, WEBHOOK_SECRET ${dim('(values not printed)')}\n`);
  console.log(`  ${red('BACK UP TOKEN_ENC_KEY SEPARATELY FROM YOUR DATABASE DUMP.')}`);
  console.log(`  It decrypts stored forge credentials. A database restored without`);
  console.log(`  it cannot use any connection it contains.\n`);
  console.log(`  Next:  deploy/up.sh\n`);
}

main();
