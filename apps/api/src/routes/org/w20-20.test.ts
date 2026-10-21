import 'dotenv/config';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { core, createDb, facts, read, security, type Database } from '@repopulse/shared';
import { rangeBounds } from '@repopulse/metrics';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';
import orgRoutes from './index.js';
import securityRoutes from '../security/index.js';
import prsRoutes from '../prs/index.js';

// W20-20 (UX_TODO DSH-56). A custom date range used to be read through the
// smallest preset ending TODAY. /org/summary now computes the KPI tiles for
// exactly the chosen days from the warehouse, with a delta against the equally
// long period before. Facts are placed inside, before and after the range so a
// wrong bound shows up as a wrong number.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RANGE = '2026-09-01..2026-09-14';
const IN = new Date('2026-09-05T12:00:00Z');
const LAST_DAY = new Date('2026-09-14T23:00:00Z');
const BEFORE = new Date('2026-08-25T12:00:00Z');
const AFTER = new Date('2026-09-20T12:00:00Z');

describe('rangeBounds', () => {
  const now = new Date('2026-10-21T10:00:00Z');
  it('makes `to` inclusive and the previous period equally long', () => {
    const b = rangeBounds('2026-09-01', '2026-09-14', now)!;
    expect(b.days).toBe(14);
    expect(b.end.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(b.previous.start.toISOString()).toBe('2026-08-18T00:00:00.000Z');
    expect(b.previous.end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
  it('refuses reversed, future, impossible and over-long ranges', () => {
    expect(rangeBounds('2026-09-14', '2026-09-01', now)).toBeNull();
    expect(rangeBounds('2026-10-01', '2026-10-22', now)).toBeNull();
    expect(rangeBounds('2026-02-30', '2026-03-02', now)).toBeNull();
    expect(rangeBounds('2025-01-01', '2026-10-01', now)).toBeNull();
    expect(rangeBounds('2026-10-21', '2026-10-21', now)?.days).toBe(1);
  });
});

describeIfDb('/org/summary for a custom date range (W20-20, DSH-56)', () => {
  const db: Database = createDb(databaseUrl as string);
  const TAG = `w20-20-${process.pid}`;
  let app: FastifyInstance;
  let workspaceId: number;
  let otherWorkspaceId: number;
  let userId: number;
  let connectionId: number;
  let repoId: number;
  let otherRepoId: number;

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
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: TAG, login: TAG })
      .returning();
    userId = user!.id;
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
      .values([repoRow(workspaceId, 'range'), repoRow(otherWorkspaceId, 'elsewhere')])
      .returning();
    repoId = repo!.id;
    otherRepoId = otherRepo!.id;

    const [dev, reviewer] = await db
      .insert(core.identities)
      .values([
        { workspaceId, provider: 'github', forgeLogin: `${TAG}-dev`, displayName: 'dev' },
        { workspaceId, provider: 'github', forgeLogin: `${TAG}-rev`, displayName: 'rev' },
      ])
      .returning();

    // Churn: 15 lines inside, 1000 after (must not count), 40 in the period before.
    const commits = await db
      .insert(facts.commits)
      .values(
        [IN, AFTER, BEFORE].map((at, i) => ({
          workspaceId,
          repoId,
          sha: `${TAG}-c${i}`,
          authorIdentityId: dev!.id,
          committerIdentityId: dev!.id,
          authoredAt: at,
          committedAt: at,
          messageHead: 'feat',
          isRevertHeuristic: false,
          isMerge: false,
        })),
      )
      .returning();
    await db.insert(facts.commitFiles).values(
      [
        [10, 5],
        [500, 500],
        [30, 10],
      ].map(([additions, deletions], i) => ({
        workspaceId,
        repoId,
        commitId: commits[i]!.id,
        path: 'a.ts',
        additions: additions!,
        deletions: deletions!,
        status: 'modified',
      })),
    );

    // Review coverage: in range, one merged PR reviewed and one not (50%);
    // after the range one unreviewed (must not count); before, one reviewed.
    const prRow = (number: number, at: Date) => ({
      workspaceId,
      repoId,
      number,
      forgePrId: `${TAG}-${number}`,
      title: `pr ${number}`,
      authorIdentityId: dev!.id,
      state: 'merged',
      isDraft: false,
      isBot: false,
      createdAt: at,
      updatedAt: at,
      mergedAt: new Date(at.getTime() + 10 * 3_600_000),
      baseRef: 'main',
      headSha: `h${number}`,
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      lastActivityAt: at,
    });
    const prs = await db
      .insert(facts.pullRequests)
      .values([prRow(1, IN), prRow(2, LAST_DAY), prRow(3, AFTER), prRow(4, BEFORE)])
      .returning();
    await db.insert(facts.prReviews).values(
      [prs[0]!, prs[3]!].map((p, i) => ({
        workspaceId,
        repoId,
        pullRequestId: p.id,
        forgeReviewId: `${TAG}-rv${i}`,
        reviewerIdentityId: reviewer!.id,
        state: 'APPROVED',
        submittedAt: new Date(p.createdAt.getTime() + 3_600_000),
      })),
    );

    // CI: one success inside, one failure after.
    await db.insert(facts.checkRuns).values(
      [
        [IN, 'success'],
        [AFTER, 'failure'],
      ].map(([at, conclusion], i) => ({
        workspaceId,
        repoId,
        forgeRunId: `${TAG}-cr${i}`,
        kind: 'check_run',
        headSha: 'h1',
        status: 'completed',
        conclusion: conclusion as string,
        runAttempt: 1,
        startedAt: at as Date,
        completedAt: at as Date,
      })),
    );

    // Another workspace's merged PR in the same days: never counted.
    const [stranger] = await db
      .insert(core.identities)
      .values({
        workspaceId: otherWorkspaceId,
        provider: 'github',
        forgeLogin: `${TAG}-x`,
        displayName: 'x',
      })
      .returning();
    await db.insert(facts.pullRequests).values({
      ...prRow(9, IN),
      workspaceId: otherWorkspaceId,
      repoId: otherRepoId,
      authorIdentityId: stranger!.id,
    });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: TAG, name: TAG };
      request.role = 'member';
    });
    await app.register(orgRoutes, { db });
    await app.register(securityRoutes, { db } as never);
    await app.register(prsRoutes, { db });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.delete(read.findings).where(eq(read.findings.workspaceId, ws));
      await db.delete(security.scanRuns).where(eq(security.scanRuns.workspaceId, ws));
      await db.delete(facts.prReviews).where(eq(facts.prReviews.workspaceId, ws));
      await db.delete(facts.checkRuns).where(eq(facts.checkRuns.workspaceId, ws));
      await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, ws));
      await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, ws));
      await db.delete(facts.commits).where(eq(facts.commits.workspaceId, ws));
      await db.delete(core.identities).where(eq(core.identities.workspaceId, ws));
      await db.delete(core.repos).where(eq(core.repos.workspaceId, ws));
    }
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.delete(core.workspaces).where(eq(core.workspaces.id, ws));
    }
    await db.delete(core.users).where(eq(core.users.id, userId));
  });

  type Tile = {
    metric_key: string;
    value: number | null;
    previous: number | null;
    delta: number | null;
    sample: { numerator: number; denominator: number } | null;
  };
  const summary = async (query: string) => {
    const res = await app.inject({ method: 'GET', url: `/org/summary?${query}` });
    return { status: res.statusCode, body: res.json() as { tiles: Tile[]; range?: unknown } };
  };
  const tile = (tiles: Tile[], key: string) => tiles.find((t) => t.metric_key === key)!;

  it('computes the KPI tiles for exactly the chosen days, with a delta against the days before', async () => {
    const { status, body } = await summary(`window=${RANGE}`);
    expect(status).toBe(200);
    expect(body.range).toEqual({ from: '2026-09-01', to: '2026-09-14', days: 14 });
    // M1: 15 lines inside; the 1000 after the range and the 40 before are out.
    expect(tile(body.tiles, 'M1')).toMatchObject({ value: 15, previous: 40, delta: -25 });
    // M5: 1 of 2 merged PRs reviewed in range (the last day counts); 1 of 1 before.
    expect(tile(body.tiles, 'M5')).toMatchObject({
      value: 0.5,
      previous: 1,
      sample: { numerator: 1, denominator: 2 },
    });
    // M9: the failure after the range is out.
    expect(tile(body.tiles, 'M9')).toMatchObject({ value: 1, previous: null });
    // M4: both in-range PRs merged 10 hours after opening.
    expect(tile(body.tiles, 'M4').value).toBeCloseTo(10);
  });

  it('reads only repositories of the caller’s workspace', async () => {
    const { status, body } = await summary(`window=${RANGE}&repos=${otherRepoId}`);
    expect(status).toBe(200);
    for (const t of body.tiles) expect(t.value).toBeNull();
    const own = await summary(`window=${RANGE}&repos=${repoId}`);
    expect(tile(own.body.tiles, 'M5').value).toBe(0.5);
  });

  it('refuses a malformed or future range with a problem, not a crash', async () => {
    expect((await summary('window=2026-09-14..2026-09-01')).status).toBe(400);
    expect((await summary('window=2099-01-01..2099-01-02')).status).toBe(400);
    expect((await summary('window=yesterday')).status).toBe(400);
  });

  it('suggests this workspace’s PR authors for the person filter (DSH-63)', async () => {
    const body = (await app.inject({ method: 'GET', url: '/org/people' })).json() as {
      items: string[];
    };
    // The author, not the reviewer who opened nothing, and never another
    // workspace's people.
    expect(body.items).toEqual([`${TAG}-dev`]);
  });

  it('the PR list sorts by age and pages with the same sort (DSH-45)', async () => {
    const page = async (q: string) =>
      (await app.inject({ method: 'GET', url: `/prs?${q}` })).json() as {
        items: { number: number }[];
        next_cursor: string | null;
      };
    const first = await page('sort=opened:asc&limit=2');
    expect(first.items.map((p) => p.number)).toEqual([4, 1]);
    const second = await page(`sort=opened:asc&limit=2&cursor=${first.next_cursor}`);
    expect(second.items.map((p) => p.number)).toEqual([2, 3]);
    const newest = await page('sort=opened:desc&limit=1');
    expect(newest.items.map((p) => p.number)).toEqual([3]);
    // DSH-30: the PRs one person reviewed (the review-load drill-down).
    const reviewed = await page(`reviewer=${TAG}-rev&sort=opened:asc`);
    expect(reviewed.items.map((p) => p.number)).toEqual([4, 1]);
  });

  it('the Security tile and the pulse leave rules in trial out, and say what ran (DSH-76/77)', async () => {
    type Sec = {
      open_total: number;
      scanned: boolean;
      experimental_open: number;
      basis: string;
      live_checks: boolean;
      scanners_run: { key: string }[];
    };
    const before = (await app.inject({ method: 'GET', url: '/org/security' })).json() as Sec;
    expect(before.scanned).toBe(false);
    expect(before.basis).toBe('no security scan has finished');
    expect(before.live_checks).toBe(false);

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
        finishedAt: new Date(),
      })
      .returning();
    const finding = (n: number, experimental: boolean) => ({
      workspaceId,
      repoId,
      scanRunId: run!.id,
      dimension: 'secrets',
      severity: 4,
      confidence: 4,
      title: `f${n}`,
      file: 'a.ts',
      evidence: 'e',
      recommendation: 'r',
      tier: 1,
      dedupKey: `${TAG}-f${n}`,
      status: 'open',
      experimental,
    });
    await db.insert(read.findings).values([finding(1, false), finding(2, true)]);

    const after = (await app.inject({ method: 'GET', url: '/org/security' })).json() as Sec;
    expect(after).toMatchObject({ open_total: 1, experimental_open: 1, scanned: true });
    expect(after.scanners_run.map((r) => r.key)).toEqual(['secrets']);
    expect(after.basis).toBe('scanners: secrets');

    const repoTab = (
      await app.inject({ method: 'GET', url: `/repos/${repoId}/security` })
    ).json() as { open_total: number; experimental_open: number };
    expect(repoTab).toMatchObject({ open_total: 1, experimental_open: 1 });

    const pulse = (await app.inject({ method: 'GET', url: '/org/pulse?window=30d' })).json() as {
      bullets: { id: string; text: string }[];
      compared_with: string;
    };
    expect(pulse.bullets.find((b) => b.id === 'findings')?.text).toMatch(/^1 findings are open/);
    expect(pulse.compared_with).toBe('the value 30 days earlier');
  });
});
