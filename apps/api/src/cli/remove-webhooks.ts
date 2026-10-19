import 'dotenv/config';
import { createDb } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { providerForRepo } from '../workers/forge-provider.js';
import { removeWebhooks } from './remove-webhooks-run.js';

// Remove every push webhook RepoPulse registered on the forge (W20-15, UX_TODO
// X-27). deploy/uninstall.sh runs it first; it also stands alone:
//
//   pnpm remove:webhooks
//
// Reads PUBLIC_BASE_URL (where the hooks deliver), DATABASE_URL and
// TOKEN_ENC_KEY (to open each connection's token). Every call goes through the
// budgeted forge client. Nothing in the database changes.

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is required (see docs/CONFIG.md).');
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
if (!publicBaseUrl) fail('PUBLIC_BASE_URL is required: it is the address the hooks deliver to.');
let tokenKey: Buffer;
try {
  tokenKey = credentials.loadTokenKey(process.env);
} catch (err) {
  fail(`TOKEN_ENC_KEY: ${(err as Error).message}`);
}

const db = createDb(databaseUrl);
try {
  const deps = {
    db,
    tokenKey,
    ...(process.env.FORGE_BASE_URL ? { forgeBaseUrl: process.env.FORGE_BASE_URL } : {}),
    ...(process.env.FORGE_ALLOW_INSECURE_LOOPBACK === '1' ? { allowInsecureLoopback: true } : {}),
  };
  const result = await removeWebhooks(db, {
    webhookUrl: `${publicBaseUrl}/api/v1/webhooks/github`,
    providerFor: (workspaceId, repoId) =>
      providerForRepo(deps, workspaceId, repoId, { includePaused: true }),
  });
  console.log(
    `\nRemoved ${result.removed} webhook(s) across ${result.repos} tracked repositor${
      result.repos === 1 ? 'y' : 'ies'
    }.`,
  );
  if (result.failed.length > 0) {
    console.log(
      `\nCould not remove the hooks on ${result.failed.length} repositor${
        result.failed.length === 1 ? 'y' : 'ies'
      } — remove them in the forge (repository Settings → Webhooks, the one pointing at ${publicBaseUrl}):`,
    );
    for (const f of result.failed) console.log(`  - ${f.repo}: ${f.error}`);
    process.exitCode = 2;
  }
} finally {
  await db.$client.end();
}
