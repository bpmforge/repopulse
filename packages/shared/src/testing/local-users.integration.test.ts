import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { core, createDb, plans, read, type Database } from '../db/index.js';
import { deleteAllLocalUsers, userReferencingColumns } from './local-users.js';

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

  it('gives every foreign key into users a delete rule (W16-59)', async () => {
    // THE INVARIANT THAT REPLACED A LIST. Every one of these was NO ACTION, so
    // deleting a user who had generated one report or triaged one finding threw
    // — and the cleanup helper carried a hand-kept array of tables to unlink
    // first, in dependency order, which drifted twice.
    //
    // Asserted against the SCHEMA rather than a copy of it, so a table added
    // later fails HERE, at the moment it is added, rather than the next time
    // somebody tries to remove a member.
    const cols = await userReferencingColumns(db);
    expect(cols.length).toBeGreaterThan(10);

    const noAction = cols.filter((c) => c.onDelete === 'NO ACTION');
    expect(
      noAction.map((c) => `${c.table}.${c.column}`),
      'a new foreign key into users needs a delete rule: SET NULL to keep the ' +
        'row and lose the name, CASCADE when the row is not worth keeping',
    ).toEqual([]);
  });

  it('cascades only where the row is worthless without its person (W16-59)', async () => {
    // CASCADE is the destructive choice and belongs to exactly two tables. A
    // membership without a member is not a row; a saved view's ownership gates
    // visibility AND editing, so a null owner leaves one in nobody's list that
    // nobody can edit or delete. Everything else keeps the work and loses the
    // name — a report is evidence, and removing a login does not un-write it.
    const cascading = (await userReferencingColumns(db))
      .filter((c) => c.onDelete === 'CASCADE')
      .map((c) => c.table)
      .sort();
    expect(cascading).toEqual(['saved_views', 'workspace_members']);
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
      actorLogin: 'w16-58-owner',
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

    // THE WORK SURVIVES ITS AUTHOR (W16-59). The plan and its items are still
    // there with the author nulled — a plan is a decision the team made, and
    // removing a login does not un-make it. This is the assertion that changed
    // when the foreign keys did: the old cleanup DELETED the plan, because
    // NO ACTION left it no other way to remove the user at all.
    const survivingItems = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from "plan_items" where "plan_id" = ${plan!.id}`,
    );
    expect([...survivingItems][0]?.n).toBe(1);
    const survivingPlan = await db.execute<{ created_by: number | null }>(
      sql`select created_by from "improvement_plans" where "id" = ${plan!.id}`,
    );
    expect([...survivingPlan][0]?.created_by).toBeNull();

    // …and the history still says WHO, because the login was denormalised
    // beside the id at write time. Without that, a departed person's decision
    // reads as `automatic` — the analysis pass acting by itself.
    const event = await db.execute<{ actor_user_id: number | null; actor_login: string | null }>(
      sql`select actor_user_id, actor_login from "plan_item_events" where "plan_item_id" = ${item!.id}`,
    );
    expect([...event][0]?.actor_user_id).toBeNull();
    expect([...event][0]?.actor_login).toBe('w16-58-owner');

    // The saved view went WITH the account, because ownership there gates
    // visibility and editing: an unowned view sits in nobody's list.
    const views = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from "saved_views" where "name" = 'w16-58 view'`,
    );
    expect([...views][0]?.n).toBe(0);
  });

});
