import { inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { core } from '../db/index.js';

// Removing every local account, for the suites that own the "does ANY local
// account exist" predicate.
//
// THIS USED TO BE THIRTY LINES OF ORDERED DELETES. Every one of the seventeen
// foreign keys into `users` was NO ACTION, so this helper had to unlink or
// remove each referencing row by hand, in dependency order, from a list that
// had to keep matching the schema. W16-58 fixed a version of it that cleared
// two of the seventeen; the fix after that still walked the plan chain in the
// wrong order while its own comment claimed otherwise.
//
// W16-59 moved that knowledge into the database, where it belongs: every users
// foreign key is now ON DELETE SET NULL or CASCADE, so deleting the row IS the
// whole operation and there is no list left to drift. The guard beside this
// file no longer defends a hand-kept array — it asserts the invariant that
// makes the array unnecessary.

/** Every table+column with a foreign key into `users`, read from the database. */
export async function userReferencingColumns(
  db: Database,
): Promise<{ table: string; column: string; onDelete: string }[]> {
  const rows = await db.execute<{
    table_name: string;
    column_name: string;
    delete_rule: string;
  }>(sql`
    select tc.table_name, kcu.column_name, rc.delete_rule
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
    join information_schema.referential_constraints rc
      on rc.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'users'
  `);
  return [...rows].map((r) => ({
    table: r.table_name,
    column: r.column_name,
    onDelete: r.delete_rule,
  }));
}

/**
 * Delete every account with `auth_provider = 'local'`.
 *
 * Used by the suites that own the first-boot bootstrap predicate, which cannot
 * be tested without controlling whether any local account exists.
 */
export async function deleteAllLocalUsers(db: Database): Promise<void> {
  const rows = await db
    .select({ id: core.users.id })
    .from(core.users)
    .where(sql`${core.users.authProvider} = 'local'`);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await db.delete(core.users).where(inArray(core.users.id, ids));
}
