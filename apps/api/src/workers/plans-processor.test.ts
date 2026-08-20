import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, plans, read, type Database } from '@repopulse/shared';
import { plansVerifyProcessor } from './plans-processor.js';
import type { Job } from 'bullmq';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// Nightly plans.verify (W5-06, FR-PLANS-3) — the differentiator.
//
// Asserted end to end against real rows rather than through the pure engine
// (which has its own tests): what matters here is that the job WRITES the
// transition and its audit row, both ways.

describeIfLiveInfra('plans.verify', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoId: number;
  let planId: number;
  let itemId: number;
  const FP = 'w5-06-fp';
  const run = () => plansVerifyProcessor({ db })({} as Job);

  async function setMetric(value: string) {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
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

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'default', name: 'Default' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'Default' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: 'w5-06-user', forgeUserId: 'w5-06-user', login: 'w5-06-user' })
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
        evidence: { metricKeys: ['M5'] },
        recommendation: 'Adopt a review SLA',
        effort: 'M',
        status: 'accepted',
        verifyCriterion: { metricKey: 'M5', op: 'gte', target: 0.8, windowDays: 30 },
      })
      .returning();
    itemId = item!.id;
  });

  afterAll(async () => {
    await db.delete(plans.planItemEvents).where(eq(plans.planItemEvents.workspaceId, workspaceId));
    await db.delete(plans.planItems).where(eq(plans.planItems.workspaceId, workspaceId));
    await db.delete(plans.improvementPlans).where(eq(plans.improvementPlans.workspaceId, workspaceId));
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    await db.delete(core.repos).where(eq(core.repos.id, repoId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.credentialFingerprint, FP));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w5-06-user'));
    await db.$client.end();
  });

  const statusOf = async () => {
    const [row] = await db.select().from(plans.planItems).where(eq(plans.planItems.id, itemId));
    return row!.status;
  };
  const eventsFor = async (to: string) =>
    db
      .select()
      .from(plans.planItemEvents)
      .where(and(eq(plans.planItemEvents.planItemId, itemId), eq(plans.planItemEvents.toStatus, to)));

  it('closes accepted work when its metric reaches the target', async () => {
    await setMetric('0.90');
    const summary = await run();
    expect(summary.done).toBe(1);
    expect(await statusOf()).toBe('done');

    const [event] = await eventsFor('done');
    expect(event!.fromStatus).toBe('accepted');
    // null actor = the verifier. Without that an automatic close is
    // indistinguishable from a colleague clicking "done".
    expect(event!.actorUserId).toBeNull();
    expect(event!.reason).toContain('M5');
  });

  it('reopens it as regressed when the metric later breaks', async () => {
    await setMetric('0.30');
    const summary = await run();
    expect(summary.regressed).toBe(1);
    expect(await statusOf()).toBe('regressed');
    const [event] = await eventsFor('regressed');
    expect(event!.actorUserId).toBeNull();
  });

  it('does NOT regress when the metric is merely missing', async () => {
    // The most consequential negative case in this ticket: a snapshot that
    // stopped being computed must never tell a team their fix came undone.
    await setMetric('0.95');
    await run();
    expect(await statusOf()).toBe('done');

    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
    const before = (await eventsFor('regressed')).length;
    await run();
    expect(await statusOf()).toBe('done');
    // And no event either — the log records changes, not nightly heartbeats.
    expect((await eventsFor('regressed')).length).toBe(before);
  });
});
