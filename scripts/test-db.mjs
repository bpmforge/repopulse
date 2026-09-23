// The vitest suite's own database (W17-42).
//
// `pnpm test` used to run against the database `.env` names — the developer's
// dev database — and the seed reset (packages/shared/src/testing/seed) wipes
// every forge connection and repo in its Default workspace. A developer's real
// forge connection disappeared on the next `pnpm test` (observed 2026-09-23).
//
// The suite now gets `<dev name>_test` on the same server: created on first
// use, migrated with the same generated SQL and the same drizzle migrator the
// shipped `migrate` container uses (apps/api/src/migrate.ts). vitest.config.ts
// calls this before any worker starts and points DATABASE_URL at the result;
// test files `import 'dotenv/config'`, which never overrides a variable that
// is already set.
//
// `pnpm e2e` is NOT covered: Playwright drives the dev stack on purpose, and
// its global-setup still reseeds the dev Default workspace.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// `postgres` and the drizzle migrator are dependencies of @repopulse/shared,
// not of the workspace root, so resolve them from there.
const shared = createRequire(new URL('../packages/shared/package.json', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../packages/shared/drizzle', import.meta.url));

/** The suite's database URL for a dev URL: same server, database `<name>_test`. */
export function testDatabaseUrl(devUrl) {
  const url = new URL(devUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) throw new Error('DATABASE_URL names no database; cannot derive the test database');
  // Already a test database (CI, or a developer pointing .env at one): keep it.
  if (!name.endsWith('_test')) url.pathname = `/${encodeURIComponent(`${name}_test`)}`;
  return url.toString();
}

function dbNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/**
 * Create the test database if it does not exist, then apply migrations.
 * Idempotent: an up-to-date database costs one query and a no-op migrate.
 */
export async function prepareTestDatabase(testUrl) {
  const postgres = shared('postgres');
  const { drizzle } = await import(shared.resolve('drizzle-orm/postgres-js'));
  const { migrate } = await import(shared.resolve('drizzle-orm/postgres-js/migrator'));

  const name = dbNameOf(testUrl);
  const admin = new URL(testUrl);
  admin.pathname = '/postgres';
  const adminSql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const exists = await adminSql`select 1 from pg_database where datname = ${name}`;
    if (exists.length === 0) {
      try {
        await adminSql.unsafe(`create database "${name.replace(/"/g, '""')}"`);
      } catch (err) {
        // 42P04 duplicate_database: another run created it between the check
        // and the create. Anything else is real.
        if (err?.code !== '42P04') throw err;
      }
    }
  } finally {
    await adminSql.end();
  }

  const client = postgres(testUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  } finally {
    await client.end();
  }
}

/**
 * Point this process (and every worker it spawns) at the test database.
 * No DATABASE_URL = the documented offline run: nothing to isolate, no-op.
 */
export async function useTestDatabase(env = process.env) {
  const devUrl = env.DATABASE_URL;
  if (!devUrl) return null;
  const testUrl = testDatabaseUrl(devUrl);
  await prepareTestDatabase(testUrl);
  env.DATABASE_URL = testUrl;
  return testUrl;
}
