import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/index.js';
import { handledUserColumns, userReferencingColumns } from './local-users.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// W16-58. The local-account cleanup cleared two of the SEVENTEEN tables that
// reference `users`. It was enough while the demo account only ever logged in,
// and broke the moment anyone actually used the product: configuring a model,
// saving a view, generating a report, accepting a plan item, triaging a
// finding or adding an agreement all give that account rows in tables whose
// foreign keys are NO ACTION. Fifteen tests then failed with a 23503 naming
// none of them — for the person exercising the product, and nobody else.
//
// A hand-kept list cannot be trusted to stay complete, so it is checked against
// the SCHEMA rather than against itself. A table added later fails here, at the
// moment it is added, instead of the next time someone uses the demo.

describeIfLiveInfra('the local-user cleanup covers every reference (W16-58)', () => {
  const db: Database = createDb(databaseUrl as string);

  afterAll(async () => {
    await db.$client.end();
  });

  it('knows about every column that points at a user', async () => {
    const inSchema = await userReferencingColumns(db);
    expect(inSchema.length).toBeGreaterThan(10);

    const handled = new Set(handledUserColumns().map((c) => `${c.table}.${c.column}`));
    const missing = inSchema
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !handled.has(key));

    // The message names the column, because the failure this replaces named
    // only a constraint id.
    expect(missing, `add these to OWNERSHIP in local-users.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not claim to handle a column that no longer exists', async () => {
    // The other direction: a stale entry is harmless at runtime but means the
    // list has stopped describing the schema, and the next reader trusts it.
    const inSchema = new Set(
      (await userReferencingColumns(db)).map((c) => `${c.table}.${c.column}`),
    );
    const stale = handledUserColumns()
      .map((c) => `${c.table}.${c.column}`)
      .filter((key) => !inSchema.has(key));
    expect([...new Set(stale)]).toEqual([]);
  });
});
