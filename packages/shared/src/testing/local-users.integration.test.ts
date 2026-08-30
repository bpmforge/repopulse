import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { core, createDb, plans, read, type Database } from '../db/index.js';
import { deleteAllLocalUsers, handledUserColumns, userReferencingColumns } from './local-users.js';

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

  it('deletes a local account that OWNS things, not only one that logged in', async () => {
    // The list-coverage check above cannot see ORDER, and order is where this
    // broke: improvement_plans.created_by is NOT NULL so the plan goes with its
    // author, but plan_items.plan_id is NO ACTION — so deleting the plan while
    // its items stand throws, and every plan has items. The first version of
    // the helper described walking that chain in a comment and did not walk it,
    // and the coverage guard reported green.
    //
    // So this test does the thing: it gives a local account the rows a person
    // gets by USING the product, then deletes the account.
    // Upserted, so a run that failed part-way through leaves this test able to
    // run again — the row it creates is the row it is about to delete.
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w16-58-owner@example.com',
        forgeUserId: 'w16-58-owner',
        login: 'w16-58-owner',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w16-58-owner' } })
      .returning();

    const [ws] = await db.select({ id: core.workspaces.id }).from(core.workspaces).limit(1);
    if (!ws) throw new Error('no workspace to attach the fixture to');

    const [plan] = await db
      .insert(plans.improvementPlans)
      .values({
        workspaceId: ws.id,
        repoIds: [],
        window: '30d',
        catalogVersion: 'test',
        createdBy: user!.id,
      })
      .returning();
    const [item] = await db
      .insert(plans.planItems)
      .values({
        workspaceId: ws.id,
        planId: plan!.id,
        rank: 1,
        catalogId: 'test-item',
        source: 'metric',
        recommendation: 'do the thing',
        effort: 'S',
        status: 'proposed',
        evidence: {},
        verifyCriterion: { metricKey: 'M5', op: 'gte', target: 0.8, windowDays: 30 },
      })
      .returning();
    await db.insert(plans.planItemEvents).values({
      workspaceId: ws.id,
      planItemId: item!.id,
      fromStatus: 'proposed',
      toStatus: 'accepted',
      actorUserId: user!.id,
      reason: 'accepted in the walk',
    });
    await db.insert(read.savedViews).values({
      workspaceId: ws.id,
      ownerUserId: user!.id,
      name: 'w16-58 view',
      config: { widgets: [] },
    });

    // The assertion IS that this returns. Before the fix it threw 23503 on
    // plan_items, naming a constraint and none of the rows.
    await expect(deleteAllLocalUsers(db)).resolves.toBeUndefined();

    const left = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.forgeUserId, 'w16-58-owner'));
    expect(left).toEqual([]);
    // And the plan went with its author rather than being orphaned.
    const orphans = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from "plan_items" where "plan_id" = ${plan!.id}`,
    );
    expect([...orphans][0]?.n).toBe(0);
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
