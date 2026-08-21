import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { describe, expect, it, afterAll } from 'vitest';
import { createDb, type Database } from '../../../index.js';
import { FINDING_DIMENSIONS, dimensionSqlList } from '../../../dimensions.js';

// One dimension list, enforced against the running database (W9-17).
//
// Deriving the API and web facets from FINDING_DIMENSIONS makes those two
// agree by construction — a test comparing them would be a tautology. The
// copy that can still drift is the DATABASE, because the CHECK constraint is
// DDL: editing the constant changes what the code offers immediately, and
// changes what the database accepts only once a migration is generated AND
// applied. That gap is precisely what hid `slop` from W9-03 to W9-16 —
// filterable in two layers, unstorable in the third, silent until something
// tried to write one.
//
// So this asserts the constant against the constraint as the database actually
// holds it, not against the schema file that claims to define it.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

describeIfLiveInfra('findings_dimension_check matches FINDING_DIMENSIONS', () => {
  const db: Database = createDb(databaseUrl as string);

  afterAll(async () => {
    await db.$client.end();
  });

  it('every dimension the code offers is one the database accepts', async () => {
    const rows = await db.execute<{ def: string }>(
      sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'findings_dimension_check'`,
    );
    const def = rows[0]?.def;
    expect(def, 'findings_dimension_check is missing from the database').toBeTruthy();

    // Pull the quoted values out of the CHECK body rather than string-matching
    // the whole clause: Postgres re-renders the expression (casts, spacing,
    // ANY(ARRAY[...])) and an exact-text comparison would fail on formatting
    // while passing on a genuinely missing value.
    const inConstraint = [...def!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    // Widened to string[]: the constraint is read back as plain text, so the
    // two sides must be comparable as strings. Narrowing the DB side to the
    // union would be backwards — this test exists precisely because the two
    // can disagree.
    const inCode: string[] = [...FINDING_DIMENSIONS].sort();

    const missingFromDb = inCode.filter((d) => !inConstraint.includes(d));
    const missingFromCode = inConstraint.filter((d) => !inCode.includes(d));

    // Named individually, because "arrays differ" is the least useful failure
    // message available for exactly the bug this test exists to catch.
    expect(
      missingFromDb,
      'in FINDING_DIMENSIONS but NOT in the database CHECK — generate and apply a drizzle migration, or these values are offered as facets and rejected on write',
    ).toEqual([]);
    expect(
      missingFromCode,
      'in the database CHECK but NOT in FINDING_DIMENSIONS — a value the store still accepts that no facet can filter to',
    ).toEqual([]);
  });

  it('every dimension is safe to inline into DDL', () => {
    // dimensionSqlList() renders these straight into a CHECK constraint, which
    // cannot take a bound parameter. The guarantee that makes that safe is the
    // shape of the values themselves, so it is asserted rather than assumed.
    for (const dimension of FINDING_DIMENSIONS) {
      expect(dimension, dimension).toMatch(/^[a-z_]+$/);
    }
    expect(dimensionSqlList()).not.toContain('"');
    expect(dimensionSqlList().split(', ')).toHaveLength(FINDING_DIMENSIONS.length);
  });
});
