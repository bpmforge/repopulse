import 'dotenv/config';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, plans, read, type Database } from '@repopulse/shared';
import { lastVerificationOf } from '@repopulse/insights';
import { plansVerifyProcessor } from './plans-processor.js';
import type { Job } from 'bullmq';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// Nightly plans.verify (W5-06, FR-PLANS-3) — the differentiator.
//
// Asserted end to end against real rows rather than through the pure engine
// (which has its own tests): what matters here is that the job WRITES the
// transition and its audit row, both ways — and (W17-25) that it writes a
// record of every check, moves NOTHING on a missing measurement, and cannot
// write the same transition twice however many times it runs.

describeIfLiveInfra('plans.verify', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoId: number;
  let planId: number;
  let itemId: number;
  const FP = 'w5-06-fp';
  const run = () => plansVerifyProcessor({ db })({} as Job);

  async function setMetric(value: string | null) {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    if (value === null) return;
    await db.insert(read.metricSnapshots).values({
      workspaceId,
      repoId,
      metricKey: 'M5',
      window: '30d',
      value,
      dims: {},
      computedAt: new Date(),
    });
  }

  /** A human decision, as the PATCH route would write it (proved there). */
  async function humanSets(status: 'accepted' | 'in_progress') {
    await db.update(plans.planItems).set({ status }).where(eq(plans.planItems.id, itemId));
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w5-06-user',
        forgeUserId: 'w5-06-user',
        login: 'w5-06-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w5-06-user' } })
      .returning();
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: FP,
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'w5-06-repo',
        org: 'acme',
        name: 'plans',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;

    const [plan] = await db
      .insert(plans.improvementPlans)
      .values({
        workspaceId,
        repoIds: [repoId],
        window: '30d',
        catalogVersion: 'v1',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    planId = plan!.id;

    const [item] = await db
      .insert(plans.planItems)
      .values({
        workspaceId,
        planId,
        rank: 1,
        catalogId: 'review-coverage-low',
        source: 'metric',
        evidence: { metricKeys: ['M5'], value: 0.4 },
        recommendation: 'Adopt a review SLA',
        effort: 'M',
        status: 'proposed',
        verifyCriterion: { metricKey: 'M5', op: 'gte', target: 0.8, windowDays: 30 },
      })
      .returning();
    itemId = item!.id;
  });

  afterAll(async () => {
    await db.delete(plans.planItemEvents).where(eq(plans.planItemEvents.planItemId, itemId));
    await db.delete(plans.planItems).where(eq(plans.planItems.id, itemId));
    await db.delete(plans.improvementPlans).where(eq(plans.improvementPlans.id, planId));
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w5-06-user'));
    await db.$client.end();
  });

  const rowOf = async () => {
    const [row] = await db.select().from(plans.planItems).where(eq(plans.planItems.id, itemId));
    return row!;
  };
  const statusOf = async () => (await rowOf()).status;
  const eventsFor = async (to: string) =>
    db
      .select()
      .from(plans.planItemEvents)
      .where(
        and(eq(plans.planItemEvents.planItemId, itemId), eq(plans.planItemEvents.toStatus, to)),
      );
  const allEvents = async () =>
    db.select().from(plans.planItemEvents).where(eq(plans.planItemEvents.planItemId, itemId));

  it("never accepts proposed work on a human's behalf, however good the number is", async () => {
    await setMetric('0.95');
    await run();
    expect(await statusOf()).toBe('proposed');
    expect(await allEvents()).toHaveLength(0);
    // Not even checked: proposed is not the verifier's to look at.
    expect(lastVerificationOf((await rowOf()).evidence)).toBeNull();
  });

  it('records an UNKNOWN check when the metric is missing, and completes nothing', async () => {
    await humanSets('accepted');
    await setMetric(null);
    const summary = await run();
    expect(summary.unknown).toBeGreaterThanOrEqual(1);
    const row = await rowOf();
    expect(row.status).toBe('accepted');
    expect(lastVerificationOf(row.evidence)).toMatchObject({ outcome: 'unknown', observed: null });
    // verified_at means "measured": an unmeasured check must not stamp it.
    expect(row.verifiedAt).toBeNull();
    expect(await allEvents()).toHaveLength(0);
  });

  it('records a BROKEN check with the number it saw, and keeps the item open', async () => {
    await setMetric('0.50');
    await run();
    const row = await rowOf();
    expect(row.status).toBe('accepted');
    expect(lastVerificationOf(row.evidence)).toMatchObject({ outcome: 'broken', observed: 0.5 });
    expect(row.verifiedAt).not.toBeNull();
    // The generator's evidence survives the record.
    expect(row.evidence).toMatchObject({ metricKeys: ['M5'], value: 0.4 });
    expect(await allEvents()).toHaveLength(0);
  });

  it('closes in-progress work when its metric reaches the target, citing the number', async () => {
    await humanSets('in_progress');
    await setMetric('0.90');
    const summary = await run();
    expect(summary.done).toBeGreaterThanOrEqual(1);
    const row = await rowOf();
    expect(row.status).toBe('done');
    expect(lastVerificationOf(row.evidence)).toMatchObject({ outcome: 'holds', observed: 0.9 });
    // The verifier is not a person.
    expect(row.statusChangedBy).toBeNull();

    const [event] = await eventsFor('done');
    expect(event!.fromStatus).toBe('in_progress');
    // null actor = the verifier. Without that an automatic close is
    // indistinguishable from a colleague clicking "done".
    expect(event!.actorUserId).toBeNull();
    expect(event!.reason).toContain('M5');
    expect(event!.reason).toContain('0.9');
  });

  it('is idempotent: running again on the same state writes no second event', async () => {
    const before = (await allEvents()).length;
    await run();
    await run();
    expect(await statusOf()).toBe('done');
    expect((await allEvents()).length).toBe(before);
  });

  it('is idempotent under a RACE: a run that read a stale status writes no event', async () => {
    // Two runs read the item as in_progress; before either can write, the
    // row is moved to done by someone else (another verifier that won). The
    // stale runs must then write NOTHING — no second done, no second event.
    // Timing alone will not produce this (a pooled second run usually reads
    // AFTER the first commits, and passed against the unguarded worker), so
    // the race is staged: a transaction holds the row lock while the runs
    // read and queue on their UPDATE, moves the row, then commits.
    await humanSets('in_progress');
    await setMetric('0.92');
    const before = (await eventsFor('done')).length;

    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select id from plan_items where id = ${itemId} for update`);
      await released;
      await tx.execute(sql`update plan_items set status = 'done' where id = ${itemId}`);
    });

    // Both runs read the row (MVCC lets the read through), then block on it.
    const runs = Promise.all([run(), run()]);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'update "plan_items"%'`,
      );
      if ((row?.n ?? 0) >= 2) break;
      if (Date.now() > deadline) throw new Error('verifier runs never reached their UPDATE');
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await holder;
    const sums = await runs;

    expect(await statusOf()).toBe('done');
    expect(sums.map((s) => s.done)).toEqual([0, 0]);
    expect((await eventsFor('done')).length).toBe(before);
  });

  it('reopens it as regressed when the metric later breaks', async () => {
    await setMetric('0.30');
    const summary = await run();
    expect(summary.regressed).toBeGreaterThanOrEqual(1);
    expect(await statusOf()).toBe('regressed');
    const [event] = await eventsFor('regressed');
    expect(event!.actorUserId).toBeNull();
    expect(event!.reason).toContain('0.3');
  });

  it('does NOT recover a regression when the metric is merely missing', async () => {
    await setMetric(null);
    const before = (await eventsFor('done')).length;
    await run();
    const row = await rowOf();
    expect(row.status).toBe('regressed');
    expect(lastVerificationOf(row.evidence)?.outcome).toBe('unknown');
    expect((await eventsFor('done')).length).toBe(before);
  });

  it('does NOT regress done work when the metric is merely missing', async () => {
    // The most consequential negative case in this ticket: a snapshot that
    // stopped being computed must never tell a team their fix came undone.
    await setMetric('0.95');
    await run();
    expect(await statusOf()).toBe('done');

    await setMetric(null);
    const before = (await eventsFor('regressed')).length;
    await run();
    const row = await rowOf();
    expect(row.status).toBe('done');
    // The check is still recorded — the UI says "not measured", not "verified".
    expect(lastVerificationOf(row.evidence)?.outcome).toBe('unknown');
    // And no event either — the log records changes, not nightly heartbeats.
    expect((await eventsFor('regressed')).length).toBe(before);
  });
});
