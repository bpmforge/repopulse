import { inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { core } from '../db/index.js';

// Removing every local account, for the suites that own the "does ANY local
// account exist" predicate (W16-58).
//
// This lived as a copy inside each of two test files and cleared exactly two of
// the SEVENTEEN tables that reference `users`. That was enough for as long as
// the demo account only ever logged in. The moment someone actually USED the
// product — configured a model, saved a view, generated a report, accepted a
// plan item, triaged a finding, added an agreement — the account owned rows in
// tables with `NO ACTION` foreign keys, and `pnpm test` failed fifteen tests
// with a 23503 that named none of them.
//
// It failed for the person exercising the product and passed for everyone else,
// which is the worst possible distribution of a broken test.
//
// The real defect underneath is that none of these ownership columns is
// `ON DELETE SET NULL`, so in production a member who has used RepoPulse cannot
// be deleted at all — filed as its own ticket rather than smuggled in here as a
// migration. This helper only has to make the SUITES honest.

/**
 * Ownership columns that may point at a user, and what to do with each.
 *
 * `null` where the column is nullable — an agreement's author leaving does not
 * un-write the agreement, and the row is not this suite's to remove. `delete`
 * where it is NOT NULL and the row cannot outlive its owner.
 *
 * ORDER MATTERS for the deletes: children before parents.
 */
const OWNERSHIP: { table: string; column: string; action: 'null' | 'delete' }[] = [
  // Nullable — unlink and leave the row.
  { table: 'identities', column: 'user_id', action: 'null' },
  { table: 'findings', column: 'status_changed_by', action: 'null' },
  { table: 'finding_events', column: 'actor', action: 'null' },
  { table: 'plan_item_events', column: 'actor_user_id', action: 'null' },
  { table: 'plan_items', column: 'status_changed_by', action: 'null' },
  { table: 'repo_scanner_config', column: 'updated_by', action: 'null' },
  { table: 'vex_statements', column: 'author_user_id', action: 'null' },
  { table: 'rule_registry', column: 'updated_by', action: 'null' },
  // NOT NULL — the row goes with the user. Plans before their items would
  // violate the items' own foreign key, so the chain is walked leaf-first.
  { table: 'plan_item_events', column: 'actor_user_id', action: 'delete' },
  { table: 'reports', column: 'generated_by', action: 'delete' },
  { table: 'saved_views', column: 'owner_user_id', action: 'delete' },
  { table: 'egress_audit', column: 'initiator_user_id', action: 'delete' },
  { table: 'agreements', column: 'created_by', action: 'delete' },
  { table: 'file_intents', column: 'created_by', action: 'delete' },
  { table: 'llm_providers', column: 'created_by', action: 'delete' },
  { table: 'improvement_plans', column: 'created_by', action: 'delete' },
  { table: 'forge_connections', column: 'created_by', action: 'delete' },
  { table: 'workspace_members', column: 'user_id', action: 'delete' },
];

/** Every table+column with a foreign key into `users`, read from the database. */
export async function userReferencingColumns(
  db: Database,
): Promise<{ table: string; column: string }[]> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    select tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'users'
  `);
  return [...rows].map((r) => ({ table: r.table_name, column: r.column_name }));
}

/** The columns this helper knows how to clear — for the guard test. */
export function handledUserColumns(): { table: string; column: string }[] {
  return OWNERSHIP.map(({ table, column }) => ({ table, column }));
}

/**
 * Delete every account with `auth_provider = 'local'`, and whatever points at
 * them.
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

  // The id list is INLINED rather than bound, because these statements are
  // built from table and column names and cannot carry a parameterised array
  // alongside them. Safe by construction: the ids come from the query above and
  // are coerced through Number, so nothing but digits reaches the SQL.
  const idList = sql.raw(ids.map((id) => Number(id)).join(', '));

  for (const { table, column, action } of OWNERSHIP) {
    const target = sql.raw(`"${table}"`);
    const col = sql.raw(`"${column}"`);
    if (action === 'null') {
      await db.execute(sql`update ${target} set ${col} = null where ${col} in (${idList})`);
    } else {
      await db.execute(sql`delete from ${target} where ${col} in (${idList})`);
    }
  }

  await db.delete(core.users).where(inArray(core.users.id, ids));
}
