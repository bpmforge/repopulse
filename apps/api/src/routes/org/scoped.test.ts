import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  core,
  createDb,
  facts,
  plans as plansSchema,
  read,
  security,
  type Database,
} from '@repopulse/shared';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import orgRoutes from './index.js';
import riskRoutes from '../risk/index.js';
import securityRoutes from '../security/index.js';
import meRoutes from '../me/index.js';
import plansRoutes from '../plans/index.js';
import { combineRows, scopedMetrics } from '../../lib/scope-metrics.js';
import { repoHealthMany } from './health.js';
import { collectTopActions } from './top-actions.js';

// W20-09 against a real Postgres, in a workspace of its own so every
// "whole workspace" read below is fully known.
//
// - DSH-86/DSH-02: a set's metric value is computed from the set, not the
//   newest row of one repository; the KPI row, pulse, next actions, security
//   and risk endpoints take a view's repositories.
// - DSH-73: open security findings reach the health score.
// - DSH-11/72: risk axes are numbers with a band word, rolled up org-wide, and
//   Performance (which had no sub-score) is gone.
// - DSH-57/58: dismissals are scoped; a regeneration supersedes and carries.
// - DSH-85: the review queue leaves out drafts, bots and PRs already reviewed.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const CSRF = { 'x-requested-with': 'repopulse' };
const W = '30d';
const DAY = 86_400_000;

function rowOf(over: {
  repoId: number;
  value: number;
  numerator?: number | null;
  denominator?: number | null;
  dims?: Record<string, unknown>;
}) {
  return {
    repoId: over.repoId,
    metricKey: 'K',
    value: String(over.value),
    numerator:
      over.numerator === undefined || over.numerator === null ? null : String(over.numerator),
    denominator:
      over.denominator === undefined || over.denominator === null ? null : String(over.denominator),
    dims: over.dims ?? {},
  };
}

describe('combineRows (W20-09, UX_TODO DSH-86)', () => {
  it('pools a ratio from numerators and denominators, never the newest row', () => {
    const r = combineRows('M5', [
      { ...rowOf({ repoId: 1, value: 0.99, numerator: 99, denominator: 100 }), metricKey: 'M5' },
      { ...rowOf({ repoId: 2, value: 0, numerator: 0, denominator: 2 }), metricKey: 'M5' },
    ]);
    expect(r.value).toBeCloseTo(99 / 102);
  });

  it('sums counts, and sums FINDINGS dims while merging their id lists', () => {
    expect(
      combineRows('M8', [rowOf({ repoId: 1, value: 3 }), rowOf({ repoId: 2, value: 4 })]).value,
    ).toBe(7);
    const f = combineRows('FINDINGS', [
      rowOf({ repoId: 1, value: 1, dims: { kevOrChainOpen: 1, kevFindingIds: [5] } }),
      rowOf({ repoId: 2, value: 2, dims: { kevOrChainOpen: 2, kevFindingIds: [6, 5] } }),
    ]);
    expect(f.dims).toMatchObject({ kevOrChainOpen: 3, kevFindingIds: [5, 6] });
  });

  it('takes the worst repository for a percentile, in the metric’s direction', () => {
    // M4 cycle time: lower is better, so the set is as slow as its slowest.
    expect(
      combineRows('M4', [rowOf({ repoId: 1, value: 10 }), rowOf({ repoId: 2, value: 50 })]).value,
    ).toBe(50);
    // A lower-is-better dim takes the max; bus factor the min.
    const m9 = combineRows('M9', [
      rowOf({ repoId: 1, value: 0.9, dims: { topFlakiness: 0.01, passRate: 0.9 } }),
      rowOf({ repoId: 2, value: 0.7, dims: { topFlakiness: 0.2, passRate: 0.7 } }),
    ]);
    expect(m9.dims).toMatchObject({ topFlakiness: 0.2, passRate: 0.7 });
    expect(m9.value).toBe(0.7);
  });

  it('pools M13 rework from the line counts in its dims', () => {
    const r = combineRows('M13', [
      rowOf({ repoId: 1, value: 0.5, dims: { reworkLines: 50, totalLines: 100 } }),
      rowOf({ repoId: 2, value: 0, dims: { reworkLines: 0, totalLines: 900 } }),
    ]);
    expect(r.value).toBeCloseTo(0.05);
  });
});

describeIfDb('repo-scoped endpoints and plans (W20-09)', () => {
  const db: Database = createDb(databaseUrl as string);
  const TAG = `w20-09-${process.pid}`;
  let app: FastifyInstance;
  let workspaceId: number;
  let userId: number;
  const role: 'admin' | 'member' = 'member';
  let connectionId: number;
  let repoA: number;
  let repoB: number;
  let repoC: number;
  let meIdentity: number;
  let otherIdentity: number;
  let botIdentity: number;

  beforeAll(async () => {
    const [ws] = await db.insert(core.workspaces).values({ slug: TAG, name: TAG }).returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: TAG, forgeUserId: TAG, login: TAG })
      .returning();
    userId = user!.id;
    await db.insert(core.workspaceMembers).values({ workspaceId, userId, role: 'member' });
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: `${TAG}-fp`,
        status: 'active',
        createdBy: userId,
      })
      .returning();
    connectionId = conn!.id;
    const repos = await db
      .insert(core.repos)
      .values(
        ['alpha', 'beta', 'gamma'].map((name) => ({
          workspaceId,
          connectionId,
          forgeRepoId: `${TAG}-${name}`,
          org: 'acme',
          name,
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
          pushedAt: new Date(),
        })),
      )
      .returning();
    [repoA, repoB, repoC] = repos.map((r) => r.id) as [number, number, number];

    // M5: alpha 99/100 written FIRST, beta 0/2 written LAST — the old reader
    // took beta's 0 for the pair. Older rows a window back give a delta.
    const old = new Date(Date.now() - 40 * DAY);
    await db.insert(read.metricSnapshots).values([
      {
        workspaceId,
        repoId: repoA,
        metricKey: 'M5',
        window: W,
        dims: {},
        value: '0.5',
        numerator: '1',
        denominator: '2',
        computedAt: old,
      },
      {
        workspaceId,
        repoId: repoA,
        metricKey: 'M5',
        window: W,
        dims: {},
        value: '0.99',
        numerator: '99',
        denominator: '100',
        computedAt: new Date(Date.now() - 2000),
      },
      {
        workspaceId,
        repoId: repoB,
        metricKey: 'M5',
        window: W,
        dims: {},
        value: '0',
        numerator: '0',
        denominator: '2',
        computedAt: new Date(Date.now() - 1000),
      },
      {
        workspaceId,
        repoId: repoA,
        metricKey: 'M6',
        window: W,
        dims: {},
        value: '0.4',
        numerator: '4',
        denominator: '10',
      },
      {
        workspaceId,
        repoId: repoB,
        metricKey: 'M6',
        window: W,
        dims: {},
        value: '0',
        numerator: '0',
        denominator: '10',
      },
    ]);

    // Identities and PRs for the review queue.
    const ids = await db
      .insert(core.identities)
      .values([
        {
          workspaceId,
          provider: 'github',
          forgeLogin: `${TAG}-me`,
          forgeUserId: TAG,
          displayName: 'me',
          userId,
        },
        { workspaceId, provider: 'github', forgeLogin: `${TAG}-dev`, displayName: 'dev' },
        {
          workspaceId,
          provider: 'github',
          forgeLogin: `${TAG}-bot[bot]`,
          displayName: 'bot',
          isBot: true,
        },
      ])
      .returning();
    [meIdentity, otherIdentity, botIdentity] = ids.map((i) => i.id) as [number, number, number];
    const pr = (number: number, author: number, over: Record<string, unknown> = {}) => ({
      workspaceId,
      repoId: repoA,
      number,
      forgePrId: `${TAG}-${number}`,
      title: `pr ${number}`,
      authorIdentityId: author,
      state: 'open',
      isDraft: false,
      isBot: false,
      createdAt: new Date(Date.now() - number * DAY),
      updatedAt: new Date(),
      baseRef: 'main',
      headSha: 'abc',
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      ...over,
    });
    const prs = await db
      .insert(facts.pullRequests)
      .values([
        pr(1, otherIdentity),
        pr(2, otherIdentity, { isDraft: true }),
        pr(3, botIdentity, { isBot: true }),
        pr(4, otherIdentity),
        pr(5, meIdentity),
        // W20-16 (DSH-85): request lists captured. #6 asks me (listed even
        // though I reviewed it once: a re-request puts me back on the list),
        // #7 asks someone else, #8 asks nobody.
        pr(6, otherIdentity, { requestedReviewerIdentityIds: [meIdentity] }),
        pr(7, otherIdentity, { requestedReviewerIdentityIds: [otherIdentity] }),
        pr(8, otherIdentity, { requestedReviewerIdentityIds: [] }),
      ])
      .returning();
    // Already reviewed by me: #4.
    // And #6, before it was re-requested from me.
    await db.insert(facts.prReviews).values(
      [prs[3]!, prs[5]!].map((p, i) => ({
        workspaceId,
        repoId: repoA,
        pullRequestId: p.id,
        forgeReviewId: `${TAG}-r${i + 1}`,
        reviewerIdentityId: meIdentity,
        state: 'APPROVED',
        submittedAt: new Date(),
      })),
    );

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: TAG, name: TAG };
      request.role = role;
      (request as unknown as { session: { get: (k: string) => unknown } }).session = {
        get: (k: string) => (k === 'userId' ? userId : undefined),
      };
    });
    await app.register(orgRoutes, { db });
    await app.register(riskRoutes, { db });
    await app.register(securityRoutes, { db } as never);
    await app.register(meRoutes, { db } as never);
    await app.register(plansRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    const planIds = (
      await db
        .select({ id: plansSchema.improvementPlans.id })
        .from(plansSchema.improvementPlans)
        .where(eq(plansSchema.improvementPlans.workspaceId, workspaceId))
    ).map((p) => p.id);
    if (planIds.length > 0) {
      await db
        .delete(plansSchema.planItemEvents)
        .where(eq(plansSchema.planItemEvents.workspaceId, workspaceId));
      await db.delete(plansSchema.planItems).where(inArray(plansSchema.planItems.planId, planIds));
      await db
        .delete(plansSchema.improvementPlans)
        .where(inArray(plansSchema.improvementPlans.id, planIds));
    }
    await db.delete(read.findings).where(eq(read.findings.workspaceId, workspaceId));
    await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, workspaceId));
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, workspaceId));
    await db.delete(facts.prReviews).where(eq(facts.prReviews.workspaceId, workspaceId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db
      .delete(core.workspaceMembers)
      .where(eq(core.workspaceMembers.workspaceId, workspaceId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.delete(core.users).where(eq(core.users.id, userId));
  });

  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode, url).toBe(200);
    return res.json() as Record<string, unknown>;
  };

  it('a set’s value is pooled from the set, not the newest repository’s row (DSH-86)', async () => {
    const set = await scopedMetrics(db, workspaceId, [repoA, repoB], W);
    expect(set.M5?.value).toBeCloseTo(99 / 102);
    // The whole workspace has no org rollup row here, and still has a value.
    const all = await scopedMetrics(db, workspaceId, [], W);
    expect(all.M5?.value).toBeCloseTo(99 / 102);
    // One window back is the older row.
    const before = await scopedMetrics(db, workspaceId, [repoA], W, {
      asOf: new Date(Date.now() - 31 * DAY),
    });
    expect(before.M5?.value).toBe(0.5);
  });

  it('the KPI row takes a view’s repositories (DSH-02)', async () => {
    const body = (await get(`/org/summary?window=${W}&repos=${repoA}`)) as {
      tiles: { metric_key: string; value: number | null; previous: number | null }[];
    };
    const m5 = body.tiles.find((t) => t.metric_key === 'M5')!;
    expect(m5.value).toBe(0.99);
    expect(m5.previous).toBe(0.5);
    // Another repository's set is that set's value.
    const pair = (await get(`/org/summary?window=${W}&repos=${repoA},${repoB}`)) as typeof body;
    expect(pair.tiles.find((t) => t.metric_key === 'M5')!.value).toBeCloseTo(99 / 102);
  });

  it('the pulse speaks for the view’s repositories (DSH-02)', async () => {
    const body = (await get(`/org/pulse?window=${W}&repos=${repoB}`)) as {
      bullets: { id: string; text: string }[];
    };
    expect(body.bullets.length).toBeGreaterThan(0);
    // W20-16 (UX_TODO DSH-84): no scan has finished for repoB, so its zero
    // open findings are "not measured", not "no findings are open".
    expect(body.bullets.find((b) => b.id === 'findings')?.text).toBe(
      'No scans have run yet, so open findings are not measured.',
    );
  });

  it('feeds open security findings into the health score (DSH-73)', async () => {
    const repos = [
      { id: repoA, pushedAt: new Date() },
      { id: repoC, pushedAt: new Date() },
    ];
    // Nothing has examined either repository: no security sub-score.
    let healths = await repoHealthMany(db, workspaceId, repos, W, Date.now());
    expect(healths.get(repoC)!.subScores.some((s) => s.key === 'security')).toBe(false);

    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId: repoC,
        scannerKey: 'secrets',
        scannerVersion: '1',
        commitSha: 'abc',
        trigger: 'manual',
        status: 'succeeded',
      })
      .returning();
    // A clean scan scores security at the top of its ramp.
    healths = await repoHealthMany(db, workspaceId, repos, W, Date.now());
    expect(healths.get(repoC)!.subScores.find((s) => s.key === 'security')?.normalized).toBe(100);

    await db.insert(read.findings).values({
      workspaceId,
      repoId: repoC,
      scanRunId: run!.id,
      dimension: 'secrets',
      severity: 5,
      confidence: 5,
      title: 'Live AWS key',
      file: 'src/app.ts',
      evidence: 'e',
      recommendation: 'rotate',
      tier: 1,
      dedupKey: `${TAG}-f1`,
      status: 'open',
      effectiveRisk: '90.00',
    });
    healths = await repoHealthMany(db, workspaceId, repos, W, Date.now());
    const sec = healths.get(repoC)!.subScores.find((s) => s.key === 'security')!;
    // Severity 5 is the worst end of both inputs' ramps... nearly: 5 of 10
    // severity-weighted is the density ramp's midpoint.
    expect(sec.normalized).toBeCloseTo((50 + 0) / 2);
  });

  it('risk axes are scores with a band word, rolled up org-wide, with no Performance axis (DSH-11/72/73)', async () => {
    const body = (await get('/risk/axes')) as {
      axes: {
        axis: string;
        score: number | null;
        band: string | null;
        basis: string;
        letter?: unknown;
      }[];
      repos_in_scope: number;
    };
    expect(body.axes.map((a) => a.axis)).toEqual(['security', 'codeHealth', 'supplyChain']);
    expect(body.repos_in_scope).toBe(3);
    const sec = body.axes.find((a) => a.axis === 'security')!;
    // Measured org-wide now (repoC was scanned above), as a number + word.
    expect(sec.score).toBe(25);
    expect(sec.band).toBe('attend');
    expect(sec).not.toHaveProperty('letter');
    // A set of one names itself; the workspace rolls up.
    const one = (await get(`/risk/axes?repos=${repoA}`)) as typeof body;
    expect(one.axes.find((a) => a.axis === 'security')!.score).toBeNull();
    expect(one.axes.find((a) => a.axis === 'security')!.basis).toMatch(
      /no scanner or analysis run/,
    );
    // W20-16 (UX_TODO DSH-82): the window the header's health badge uses;
    // anything else reads as the 30-day default, and says which it used.
    expect(((await get('/risk/axes?window=90d')) as { window: string }).window).toBe('90d');
    expect(((await get('/risk/axes?window=bogus')) as { window: string }).window).toBe('30d');
    expect(((await get('/risk/axes')) as { window: string }).window).toBe('30d');
  });

  it('top risks, security and next actions take a view’s repositories (DSH-02)', async () => {
    const all = (await get('/risk/top')) as { counts: { open: number } };
    expect(all.counts.open).toBe(1);
    const scoped = (await get(`/risk/top?repos=${repoA},${repoB}`)) as typeof all;
    expect(scoped.counts.open).toBe(0);

    const secAll = (await get('/org/security')) as { secrets_open: number };
    expect(secAll.secrets_open).toBe(1);
    const secScoped = (await get(`/org/security?repos=${repoA}`)) as typeof secAll;
    expect(secScoped.secrets_open).toBe(0);

    const actionsAll = await collectTopActions(db, workspaceId);
    expect(actionsAll.actions.some((a) => a.title.includes('Live AWS key'))).toBe(true);
    const actionsScoped = await collectTopActions(db, workspaceId, { repoIds: [repoA] });
    expect(actionsScoped.actions.some((a) => a.title.includes('Live AWS key'))).toBe(false);
    const wire = (await get(`/org/top-actions?repos=${repoA}`)) as { actions: unknown[] };
    expect(Array.isArray(wire.actions)).toBe(true);
  });

  it('the review queue lists PRs that ask me, and uncaptured ones by the old rule (DSH-85)', async () => {
    const body = (await get('/me/review-queue')) as {
      items: { number: number; requested: boolean | null }[];
    };
    // Oldest first: #6 (asked me) then #1 (request list not captured, not
    // reviewed by me). Drafts, bots, mine, reviewed-uncaptured (#4), asked
    // someone else (#7) and asked nobody (#8) are all left out.
    expect(body.items.map((i) => [i.number, i.requested])).toEqual([
      [6, true],
      [1, null],
    ]);
  });

  async function generate(repoIds: number[]) {
    const res = await app.inject({
      method: 'POST',
      url: '/plans',
      headers: CSRF,
      payload: { window: W, repo_ids: repoIds },
    });
    expect(res.statusCode).toBeLessThan(300);
    return res.json() as { id: number; reused: boolean; superseded_id: number | null };
  }
  const itemsOf = (planId: number) =>
    db.select().from(plansSchema.planItems).where(eq(plansSchema.planItems.planId, planId));

  it('a dismissal hides an item from its own scope’s plans only (DSH-57)', async () => {
    const forA = await generate([repoA]);
    const item = (await itemsOf(forA.id)).find((i) => i.catalogId === 'unreviewed-merges');
    expect(item).toBeDefined();
    const res = await app.inject({
      method: 'PATCH',
      url: `/plans/items/${item!.id}`,
      headers: CSRF,
      payload: { status: 'dismissed', reason: 'not here' },
    });
    expect(res.statusCode).toBe(200);

    // Another scope that breaches the same threshold still gets the item.
    const pair = await generate([repoA, repoB]);
    const pairItems = await itemsOf(pair.id);
    expect(pairItems.find((i) => i.catalogId === 'unreviewed-merges')?.status).toBe('proposed');

    // Restore it so the next test starts from a proposed item.
    await app.inject({
      method: 'PATCH',
      url: `/plans/items/${item!.id}`,
      headers: CSRF,
      payload: { status: 'proposed' },
    });
  });

  it('regenerating supersedes the plan for the scope and carries decided items (DSH-58)', async () => {
    const first = await generate([repoA]);
    const items = await itemsOf(first.id);
    const kept = items.find((i) => i.catalogId === 'unreviewed-merges')!;
    await app.inject({
      method: 'PATCH',
      url: `/plans/items/${kept.id}`,
      headers: CSRF,
      payload: { status: 'accepted' },
    });

    // The metrics move: review coverage for alpha falls, raising a new item.
    await db.insert(read.metricSnapshots).values({
      workspaceId,
      repoId: repoA,
      metricKey: 'M5',
      window: W,
      dims: {},
      value: '0.1',
      numerator: '1',
      denominator: '10',
    });
    const second = await generate([repoA]);
    expect(second.reused).toBe(false);
    expect(second.superseded_id).toBe(first.id);

    const [old] = await db
      .select({ status: plansSchema.improvementPlans.status })
      .from(plansSchema.improvementPlans)
      .where(eq(plansSchema.improvementPlans.id, first.id));
    expect(old!.status).toBe('archived');
    const carried = (await itemsOf(second.id)).find((i) => i.catalogId === 'unreviewed-merges')!;
    expect(carried.status).toBe('accepted');
    const events = await db
      .select()
      .from(plansSchema.planItemEvents)
      .where(eq(plansSchema.planItemEvents.planItemId, carried.id));
    expect(events[0]!.reason).toBe(`carried over from plan #${first.id}`);

    // The list puts the current plan first and still has the old one.
    const list = (await get('/plans')) as {
      truncated: boolean;
      items: { id: number; status: string }[];
    };
    expect(list.truncated).toBe(false);
    const firstArchived = list.items.findIndex((p) => p.status === 'archived');
    expect(list.items.slice(0, firstArchived).every((p) => p.status === 'active')).toBe(true);
    expect(list.items.find((p) => p.id === first.id)?.status).toBe('archived');
  });

  it('a plan from a report that is not this workspace’s is a 404 (DSH-59)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/plans',
      headers: CSRF,
      payload: { window: W, repo_ids: [repoA], from_report_id: 2_147_483_000 },
    });
    expect(res.statusCode).toBe(404);
  });
});
