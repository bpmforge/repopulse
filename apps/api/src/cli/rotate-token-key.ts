import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createDb } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { RotateError, rotateTokenKey } from './rotate-token-key-run.js';

// Re-seal every stored credential under a new TOKEN_ENC_KEY (W20-10, UX_TODO
// ADM-45). See docs/RUNBOOK.md → Hand over the install / rotate secrets;
// deploy/rotate-token-key.sh wraps this for a packaged install.
//
//   TOKEN_ENC_KEY=<current> NEW_TOKEN_ENC_KEY=<new> pnpm rotate:token-key [--dry-run]
//
// Both keys come from the ENVIRONMENT, never argv: a command line is visible to
// every user on the host in `ps`. Nothing is printed but counts and the new
// key's fingerprint (a sha256 prefix, the same one backup.sh records).

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

let oldKey: Buffer;
let newKey: Buffer;
try {
  oldKey = credentials.loadTokenKey(process.env);
} catch (err) {
  fail(`Current key: ${(err as Error).message}`);
}
try {
  newKey = credentials.loadTokenKey({ TOKEN_ENC_KEY: process.env.NEW_TOKEN_ENC_KEY });
} catch {
  fail('NEW_TOKEN_ENC_KEY must be set to 32 bytes of hex — generate with: openssl rand -hex 32');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is required (see docs/CONFIG.md).');

const db = createDb(databaseUrl);
try {
  const counts = await rotateTokenKey(db, oldKey, newKey, { dryRun });
  const fp = `sha256:${createHash('sha256')
    .update((process.env.NEW_TOKEN_ENC_KEY ?? '').toLowerCase())
    .digest('hex')
    .slice(0, 16)}`;
  console.log(
    `\n${dryRun ? 'DRY RUN — nothing written. Would re-seal' : 'Re-sealed'}: ` +
      `${counts.forgeCredentials} forge credential(s), ${counts.webhookSecrets} webhook secret(s), ` +
      `${counts.modelKeys} model API key(s)` +
      (counts.alreadyRotated > 0 ? `; ${counts.alreadyRotated} already under the new key` : '') +
      `.\nNew key fingerprint: ${fp}\n`,
  );
  if (!dryRun) {
    console.log(
      'Now put the new key in deploy/.env as TOKEN_ENC_KEY and restart the api and worker.\n' +
        'Until they restart they still hold the old key and cannot open what was just re-sealed.\n' +
        'Backups taken BEFORE this need the OLD key: keep it with them.\n',
    );
  }
} catch (err) {
  if (err instanceof RotateError) {
    fail(`${err.message}\n${err.unopenable.map((u) => `  - ${u}`).join('\n')}`);
  }
  throw err;
} finally {
  await db.$client.end();
}
