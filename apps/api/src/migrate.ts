import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '@repopulse/shared';

// Migration entrypoint for the shipped container (W11-01).
//
// Deliberately does NOT use the drizzle-kit CLI. drizzle-kit is a DEV
// dependency and a build tool; requiring it at runtime meant the migrate image
// had to carry the dev toolchain, and installing it into a --prod pnpm
// workspace put nothing on the bin path (verified: /app/node_modules/.bin was
// empty). drizzle-orm ships its own migrator and is already a production
// dependency, so this needs nothing that is not shipped anyway.
//
// Reads the SAME generated SQL in packages/shared/drizzle that drizzle-kit
// produces, and the same __drizzle_migrations bookkeeping table — so a second
// `up` on an existing install is a no-op, not a re-migrate, exactly as before.

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required (see .env.example)');

// Through shared's own factory rather than a direct `postgres` import: the
// driver is a dependency of @repopulse/shared, not of apps/api, so importing it
// here fails to resolve in a --prod install (found by running the image).
const db = createDb(databaseUrl);

/** Migrations recorded as applied, or 0 when the ledger does not exist yet. */
async function appliedCount(): Promise<number> {
  try {
    const rows = (await db.$client`select count(*)::int as n from drizzle.__drizzle_migrations`) as unknown as {
      n: number;
    }[];
    return rows[0]?.n ?? 0;
  } catch {
    // No ledger means nothing has ever been applied — a first run, not a fault.
    return 0;
  }
}

try {
  const before = await appliedCount();
  await migrate(db, { migrationsFolder: 'packages/shared/drizzle' });
  const after = await appliedCount();

  // SAY WHICH IT WAS. "[migrate] up to date" printed identically whether it
  // had just built a schema from nothing or done nothing at all, so an
  // operator following the install guide could not tell a working first run
  // from a silently skipped one. Found by running the clean-install path
  // (W13-06) against an empty database.
  console.log(
    after > before
      ? `[migrate] applied ${after - before} migration(s); ${after} total`
      : `[migrate] up to date (${after} migration(s) already applied)`,
  );
} finally {
  await db.$client.end();
}
