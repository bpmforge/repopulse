import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { resetPasswordByEmail } from './reset-password-run.js';

// Reset a local account's password from the command line (W20-07, UX_TODO
// INS-03) — the way back in for a locked-out admin. See docs/RUNBOOK.md.
//
//   From a checkout:   pnpm reset:password --email admin@example.com
//   In the bundle:     podman compose -f deploy/compose.yaml exec api \
//                        tsx apps/api/src/cli/reset-password.ts --email admin@example.com
//
// Prints a one-time temporary password; the account must replace it at its
// next sign-in. Nothing secret is read from argv — the email is not one.

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const at = argv.indexOf('--email');
const email = at === -1 ? undefined : argv[at + 1];
if (!email) {
  fail('Usage: reset-password --email <the local account email>');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is required (see docs/CONFIG.md).');

const db = createDb(databaseUrl);
const outcome = await resetPasswordByEmail(db, email);
await db.$client.end();

if (!outcome.ok) {
  fail(
    `No local account with the email ${email}. GitHub and single-sign-on users reset their password with that provider.`,
  );
}
console.log(
  `\nTemporary password for ${email} (shown once):\n\n    ${outcome.temporaryPassword}\n`,
);
console.log('Sign in with it; you will be asked to choose a new password straight away.\n');
