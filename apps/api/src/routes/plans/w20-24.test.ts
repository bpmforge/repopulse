import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
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
import { securityInputsMany } from '@repopulse/insights';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import plansRoutes from './index.js';
import intentsRoutes from '../intents/index.js';
import orgRoutes from '../org/index.js';
import codeHealthRoutes from '../code-health/index.js';
import meRoutes from '../me/index.js';
import workspaceRoutes from '../admin/workspace/index.js';
import { statusOf } from '../../lib/intent-status.js';

// W20-24, against a real Postgres. DSH-44 plan item owners (a member, set on
// the item, filterable, tenancy-checked); DSH-31 debt-signal targets (settings,
// none by default, served with the Code Health tab); DSH-37 hotspot history
// behind intents (baseline on save, improved / warnings, Needs attention);
// DSH-41 review-queue waiting from the review request; and the health tile's
// earlier reading taking security findings as they were.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const DAY = 86_400_000;

describe('intent status (DSH-37, pure)', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  const declared = new Date(now.getTime() - 120 * DAY);
  const intent = (kind: string) => ({
    repoId: 1,
    path: 'a.ts',
    intent: kind,
    createdAt: declared,
    warnAfterMonths: 3,
  });
  const at = (daysAgo: number, score: number) => ({
    at: new Date(now.getTime() - daysAgo * DAY),
    score,
  });

  it('compares the first reading at or after the declaration with the newest', () => {
    const s = statusOf(intent('refactor'), [at(200, 0.1), at(120, 0.8), at(1, 0.4)], now);
    expect(s).toMatchObject({ points: 2, improved: true, warnings: [] });
    expect(s.first?.score).toBe(0.8);
  });

  it('warns on a stalled refactor through insights intentWarnings', () => {
    const s = statusOf(intent('refactor'), [at(120, 0.8), at(1, 0.8)], now);
    expect(s.improved).toBe(false);
    expect(s.warnings[0]).toMatchObject({ kind: 'refactor_stalled', months: 4 });
  });

  it('has nothing to compare with one reading, and never warns for acknowledged', () => {
    expect(statusOf(intent('refactor'), [at(1, 0.9)], now).improved).toBeNull();
    expect(statusOf(intent('acknowledged'), [at(120, 0.1), at(1, 0.9)], now).warnings).toEqual([]);
  });
});

describeIfDb('W20-24 owners, targets, hotspot history and review requests', () => {
  const db: Database = createDb(databaseUrl as string);
  const TAG = `w20-24-${process.pid}`;
  let app: FastifyInstance;
  let workspaceId: number;
  let otherWorkspaceId: number;
  let meUserId: number;
  let memberUserId: number;
  let strangerUserId: number;
  let connectionId: number;
  let repoId: number;
  let otherRepoId: number;
  let meIdentityId: number;
  let devIdentityId: number;
  let itemId: number;
  let otherItemId: number;
  let role: 'admin' | 'member' = 'member';

  const inject = (method: 'GET' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });

  beforeAll(async () => {
    const [ws, other] = await db
      .insert(core.workspaces)
      .values([
        { slug: TAG, name: TAG },
        { slug: `${TAG}-other`, name: `${TAG}-other` },
      ])
      .returning();
    workspaceId = ws!.id;
    otherWorkspaceId = other!.id;
    const users = await db
      .insert(core.users)
      .values([
        { authProvider: 'local', authSubject: `${TAG}-me`, login: `${TAG}-me` },
        { authProvider: 'local', authSubject: `${TAG}-ana`, login: `${TAG}-ana`, name: 'Ana' },
        { authProvider: 'local', authSubject: `${TAG}-x`, login: `${TAG}-x` },
      ])
      .returning();
    [meUserId, memberUserId, strangerUserId] = users.map((u) => u.id) as [number, number, number];
    await db.insert(core.workspaceMembers).values([
      { workspaceId, userId: meUserId, role: 'admin' },
      { workspaceId, userId: memberUserId, role: 'member' },
      { workspaceId: otherWorkspaceId, userId: strangerUserId, role: 'member' },
    ]);
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
        createdBy: meUserId,
      })
      .returning();
    connectionId = conn!.id;
    const repoRow = (wsId: number, name: string) => ({
      workspaceId: wsId,
      connectionId,
      forgeRepoId: `${TAG}-${name}`,
      org: 'acme',
      name,
      defaultBranch: 'main',
      isPrivate: true,
      isArchived: false,
      syncStatus: 'live',
      tier2Auto: false,
    });
    const [repo, otherRepo] = await db
      .insert(core.repos)
      .values([repoRow(workspaceId, 'w2024'), repoRow(otherWorkspaceId, 'elsewhere')])
      .returning();
    repoId = repo!.id;
    otherRepoId = otherRepo!.id;

    const [mine, dev] = await db
      .insert(core.identities)
      .values([
        {
          workspaceId,
          provider: 'github',
          forgeLogin: `${TAG}-me`,
          displayName: 'me',
          userId: meUserId,
        },
        { workspaceId, provider: 'github', forgeLogin: `${TAG}-dev`, displayName: 'dev' },
      ])
      .returning();
    meIdentityId = mine!.id;
    devIdentityId = dev!.id;

    // Plans: one item here, one in the other workspace.
    const [plan, otherPlan] = await db
      .insert(plansSchema.improvementPlans)
      .values([
        { workspaceId, repoIds: [], window: `${TAG}-w`, catalogVersion: 'v1' },
        { workspaceId: otherWorkspaceId, repoIds: [], window: `${TAG}-w`, catalogVersion: 'v1' },
      ])
      .returning();
    const itemRow = (wsId: number, planId: number) => ({
      workspaceId: wsId,
      planId,
      rank: 1,
      catalogId: 'review-coverage-low',
      source: 'metric',
      evidence: {},
      recommendation: 'Adopt a review SLA',
      effort: 'M',
      verifyCriterion: { metricKey: 'M5', op: 'gte', target: 0.8, windowDays: 30 },
    });
    const items = await db
      .insert(plansSchema.planItems)
      .values([itemRow(workspaceId, plan!.id), itemRow(otherWorkspaceId, otherPlan!.id)])
      .returning();
    itemId = items[0]!.id;
    otherItemId = items[1]!.id;

    // A commit touching the intent file today, so the baseline has a score.
    const [commit] = await db
      .insert(facts.commits)
      .values({
        workspaceId,
        repoId,
        sha: `${TAG}-c1`,
        authorIdentityId: devIdentityId,
        committerIdentityId: devIdentityId,
        authoredAt: new Date(),
        committedAt: new Date(),
        messageHead: 'feat',
        isRevertHeuristic: false,
        isMerge: false,
      })
      .returning();
    await db.insert(facts.commitFiles).values({
      workspaceId,
      repoId,
      commitId: commit!.id,
      path: 'src/hot.ts',
      additions: 50,
      deletions: 10,
      status: 'modified',
    });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: TAG, name: TAG };
      request.role = role;
      (request as unknown as { session: { get: (k: string) => unknown } }).session = {
        get: (k: string) => (k === 'userId' ? meUserId : undefined),
      };
    });
    await app.register(plansRoutes, { db });
    await app.register(intentsRoutes, { db });
    await app.register(orgRoutes, { db });
    await app.register(codeHealthRoutes, { db });
    await app.register(meRoutes, { db });
    await app.register(workspaceRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.delete(read.fileHotspotScores).where(eq(read.fileHotspotScores.workspaceId, ws));
      await db.delete(plansSchema.fileIntents).where(eq(plansSchema.fileIntents.workspaceId, ws));
      await db.delete(plansSchema.planItems).where(eq(plansSchema.planItems.workspaceId, ws));
      await db
        .delete(plansSchema.improvementPlans)
        .where(eq(plansSchema.improvementPlans.workspaceId, ws));
      await db.delete(read.findingEvents).where(eq(read.findingEvents.workspaceId, ws));
      await db.delete(read.findings).where(eq(read.findings.workspaceId, ws));
      await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, ws));
      await db.delete(facts.prReviewRequests).where(eq(facts.prReviewRequests.workspaceId, ws));
      await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, ws));
      await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, ws));
      await db.delete(facts.commits).where(eq(facts.commits.workspaceId, ws));
      await db.delete(core.identities).where(eq(core.identities.workspaceId, ws));
      await db.delete(core.repos).where(eq(core.repos.workspaceId, ws));
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.workspaceId, ws));
    }
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.delete(core.workspaces).where(eq(core.workspaces.id, ws));
    }
    for (const id of [meUserId, memberUserId, strangerUserId]) {
      await db.delete(core.users).where(eq(core.users.id, id));
    }
  });

  describe('plan item owners (DSH-44)', () => {
    it('lists this workspace’s members only', async () => {
      const res = await inject('GET', '/plans/owners');
      expect(res.statusCode).toBe(200);
      const ids = (res.json() as { items: { id: number }[] }).items.map((o) => o.id);
      expect(ids).toEqual(expect.arrayContaining([meUserId, memberUserId]));
      expect(ids).not.toContain(strangerUserId);
    });

    it('hands an item to a member, shows it on the item, and clears it', async () => {
      const set = await inject('PATCH', `/plans/items/${itemId}/owner`, {
        owner_user_id: memberUserId,
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ id: itemId, owner: { id: memberUserId, name: 'Ana' } });
      const list = (await inject('GET', '/plans')).json() as {
        items: { items: { id: number; owner: { id: number } | null }[] }[];
      };
      const shown = list.items.flatMap((p) => p.items).find((i) => i.id === itemId);
      expect(shown?.owner?.id).toBe(memberUserId);
      const cleared = await inject('PATCH', `/plans/items/${itemId}/owner`, {
        owner_user_id: null,
      });
      expect(cleared.json()).toMatchObject({ owner: null });
    });

    it('refuses a non-member (400), another workspace’s item (404) and a bad body (400)', async () => {
      expect(
        (await inject('PATCH', `/plans/items/${itemId}/owner`, { owner_user_id: strangerUserId }))
          .statusCode,
      ).toBe(400);
      expect(
        (await inject('PATCH', `/plans/items/${otherItemId}/owner`, { owner_user_id: meUserId }))
          .statusCode,
      ).toBe(404);
      expect(
        (await inject('PATCH', `/plans/items/${itemId}/owner`, { owner_user_id: 'ana' }))
          .statusCode,
      ).toBe(400);
      const [row] = await db
        .select({ owner: plansSchema.planItems.ownerUserId })
        .from(plansSchema.planItems)
        .where(eq(plansSchema.planItems.id, itemId));
      expect(row?.owner).toBeNull();
    });
  });

  describe('debt signal targets (DSH-31)', () => {
    it('has none by default and serves them with the Code Health tab once set', async () => {
      role = 'admin';
      const before = (await inject('GET', `/repos/${repoId}/code-health`)).json() as {
        targets: Record<string, number>;
      };
      expect(before.targets).toEqual({});
      const bad = await inject('PATCH', '/admin/workspace', { debt_targets: { M13: 2 } });
      expect(bad.statusCode).toBe(400);
      const unknown = await inject('PATCH', '/admin/workspace', { debt_targets: { M99: 1 } });
      expect(unknown.statusCode).toBe(400);
      const ok = await inject('PATCH', '/admin/workspace', {
        debt_targets: { M13: 0.05, ch_complexity_p90: 12 },
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { effective: { debtTargets: unknown } }).effective.debtTargets).toEqual({
        M13: 0.05,
        ch_complexity_p90: 12,
      });
      role = 'member';
      const after = (await inject('GET', `/repos/${repoId}/code-health`)).json() as {
        targets: Record<string, number>;
      };
      expect(after.targets).toEqual({ M13: 0.05, ch_complexity_p90: 12 });
      role = 'admin';
      const reset = await inject('PATCH', '/admin/workspace', { debt_targets: null });
      expect(
        (reset.json() as { stored: Record<string, unknown> }).stored.debt_targets,
      ).toBeUndefined();
      role = 'member';
    });
  });

  describe('hotspot history behind intents (DSH-37)', () => {
    it('refuses an intent on another workspace’s repository', async () => {
      const res = await inject('PUT', '/intents', {
        repo_id: otherRepoId,
        path: 'x.ts',
        intent: 'refactor',
      });
      expect(res.statusCode).toBe(404);
    });

    it('records a baseline score when the intent is saved', async () => {
      const res = await inject('PUT', '/intents', {
        repo_id: repoId,
        path: 'src/hot.ts',
        intent: 'refactor',
        note: 'split it',
      });
      expect(res.statusCode).toBe(200);
      const rows = await db
        .select()
        .from(read.fileHotspotScores)
        .where(
          and(
            eq(read.fileHotspotScores.workspaceId, workspaceId),
            eq(read.fileHotspotScores.path, 'src/hot.ts'),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.score)).toBeGreaterThan(0);
      const listed = (await inject('GET', `/intents?repo_id=${repoId}`)).json() as {
        items: { path: string; hotspot: { points: number; improved: boolean | null } }[];
      };
      expect(listed.items[0]?.hotspot).toMatchObject({ points: 1, improved: null });
    });

    it('a stalled refactor past its review date is listed in Needs attention', async () => {
      // Declared four months ago; the score then and now are the same.
      const declared = new Date(Date.now() - 120 * DAY);
      await db
        .update(plansSchema.fileIntents)
        .set({ createdAt: declared })
        .where(eq(plansSchema.fileIntents.workspaceId, workspaceId));
      await db.insert(read.fileHotspotScores).values([
        {
          workspaceId,
          repoId,
          path: 'src/hot.ts',
          window: '30d',
          score: '0.7',
          computedAt: new Date(declared.getTime() + DAY),
        },
        {
          workspaceId,
          repoId,
          path: 'src/hot.ts',
          window: '30d',
          score: '0.9',
          computedAt: new Date(Date.now() - DAY),
        },
        // Another workspace's history for the same path never counts.
        {
          workspaceId: otherWorkspaceId,
          repoId: otherRepoId,
          path: 'src/hot.ts',
          window: '30d',
          score: '0.01',
          computedAt: new Date(),
        },
      ]);
      const listed = (await inject('GET', `/intents?repo_id=${repoId}`)).json() as {
        items: { hotspot: { improved: boolean | null; warnings: { kind: string }[] } }[];
      };
      expect(listed.items[0]?.hotspot.improved).toBe(false);
      expect(listed.items[0]?.hotspot.warnings[0]?.kind).toBe('refactor_stalled');

      const attention = (await inject('GET', '/org/attention?window=30d')).json() as {
        intents: { kind: string; repo_id: number; path: string; from: number }[];
      };
      expect(attention.intents).toEqual([
        expect.objectContaining({
          kind: 'refactor_stalled',
          repo_id: repoId,
          path: 'src/hot.ts',
          from: 0.7,
        }),
      ]);
    });
  });

  describe('review queue waiting time (DSH-41)', () => {
    it('measures from my review request when known, from the opening otherwise', async () => {
      const opened = new Date(Date.now() - 10 * DAY);
      const prRow = (number: number) => ({
        workspaceId,
        repoId,
        number,
        forgePrId: `${TAG}-${number}`,
        title: `pr ${number}`,
        authorIdentityId: devIdentityId,
        state: 'open',
        isDraft: false,
        isBot: false,
        createdAt: opened,
        updatedAt: opened,
        baseRef: 'main',
        headSha: `h${number}`,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        requestedReviewerIdentityIds: [meIdentityId],
      });
      const [asked, unknown] = await db
        .insert(facts.pullRequests)
        .values([prRow(1), prRow(2)])
        .returning();
      const requestedAt = new Date(Date.now() - DAY);
      await db.insert(facts.prReviewRequests).values([
        {
          workspaceId,
          repoId,
          pullRequestId: asked!.id,
          reviewerIdentityId: meIdentityId,
          requestedAt: new Date(Date.now() - 9 * DAY),
          source: 'timeline',
        },
        // Re-requested yesterday: the newest request is the one I am waiting on.
        {
          workspaceId,
          repoId,
          pullRequestId: asked!.id,
          reviewerIdentityId: meIdentityId,
          requestedAt,
          source: 'timeline',
        },
        // Someone else's request on the other PR is not mine.
        {
          workspaceId,
          repoId,
          pullRequestId: unknown!.id,
          reviewerIdentityId: devIdentityId,
          requestedAt,
          source: 'observed',
        },
      ]);
      const res = await inject('GET', '/me/review-queue');
      expect(res.statusCode).toBe(200);
      const items = (res.json() as { items: Record<string, unknown>[] }).items;
      const one = items.find((i) => i.number === 1)!;
      const two = items.find((i) => i.number === 2)!;
      expect(one).toMatchObject({
        waiting_basis: 'review_request',
        waiting_since: requestedAt.toISOString(),
        request_source: 'timeline',
      });
      expect(two).toMatchObject({ waiting_basis: 'opened', waiting_since: opened.toISOString() });
      // Oldest wait first: the PR waiting since it opened comes before the
      // one I was asked about yesterday.
      expect(items.map((i) => i.number)).toEqual([2, 1]);
    });
  });

  describe('health change reads findings as they were (security as of)', () => {
    it('counts a finding fixed since as open in the earlier reading', async () => {
      const [run] = await db
        .insert(security.scanRuns)
        .values({
          workspaceId,
          repoId,
          scannerKey: 'secrets',
          scannerVersion: '1',
          commitSha: 'abc',
          trigger: 'manual',
          status: 'succeeded',
          startedAt: new Date(Date.now() - 60 * DAY),
          finishedAt: new Date(Date.now() - 60 * DAY),
        })
        .returning();
      const [finding] = await db
        .insert(read.findings)
        .values({
          workspaceId,
          repoId,
          scanRunId: run!.id,
          dimension: 'secrets',
          severity: 4,
          confidence: 4,
          title: 'old bug',
          file: 'a.ts',
          evidence: 'e',
          recommendation: 'r',
          tier: 1,
          dedupKey: `${TAG}-f1`,
          status: 'resolved',
          firstSeenAt: new Date(Date.now() - 60 * DAY),
        })
        .returning();
      await db.insert(read.findingEvents).values({
        workspaceId,
        findingId: finding!.id,
        fromStatus: 'open',
        toStatus: 'resolved',
        at: new Date(Date.now() - 5 * DAY),
      });
      const asOf = new Date(Date.now() - 30 * DAY);
      const now = await securityInputsMany(db, workspaceId, [repoId]);
      const then = await securityInputsMany(db, workspaceId, [repoId], asOf, {
        statusAtAsOf: true,
      });
      const todayStatus = await securityInputsMany(db, workspaceId, [repoId], asOf);
      expect(now.get(repoId)?.openFindingDensity).toBe(0);
      expect(then.get(repoId)).toEqual({ openFindingDensity: 4, worstOpenSeverity: 4 });
      // The old behaviour, still what a report pin asks for.
      expect(todayStatus.get(repoId)?.openFindingDensity).toBe(0);
    });
  });
});
