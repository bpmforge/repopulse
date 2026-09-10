import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  core,
  createDb,
  plans as plansSchema,
  read,
  security,
  type Database,
} from '@repopulse/shared';
import { collectTopActions, serializeTopActions, type TopActionsResult } from './top-actions.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

// The wire contract W17-17 reads. Pure, so it runs with or without a database —
// a deep link that is right in camelCase and wrong after snake-casing is still
// a deep link that opens nothing.
describe('serializeTopActions (W17-16)', () => {
  const result = (over: Partial<TopActionsResult> = {}): TopActionsResult => ({
    actions: [],
    coverage: null,
    generatedAt: '2026-09-10T12:00:00.000Z',
    ...over,
  });

  it('snake-cases a finding action without losing its target', () => {
    const wire = serializeTopActions(
      result({
        actions: [
          {
            id: 'finding:77',
            kind: 'finding',
            title: 'Hardcoded credential',
            reason: 'Open security finding, risk 80.0 (act).',
            repoId: 10,
            repoName: 'alpha',
            effort: null,
            target: { kind: 'finding', findingId: 77, repoId: 10 },
            href: '/findings?finding=77',
          },
        ],
      }),
    );
    expect(wire).toMatchObject({
      actions: [
        {
          id: 'finding:77',
          repo_id: 10,
          repo_name: 'alpha',
          effort: null,
          target: { kind: 'finding', finding_id: 77, repo_id: 10 },
          href: '/findings?finding=77',
        },
      ],
      coverage: null,
      generated_at: '2026-09-10T12:00:00.000Z',
    });
  });

  it('snake-cases a plan item target and carries the stored effort', () => {
    const wire = serializeTopActions(
      result({
        actions: [
          {
            id: 'plan_item:42',
            kind: 'plan_item',
            title: 'Raise review coverage',
            reason: 'Plan item ranked 1 in an active improvement plan.',
            repoId: null,
            repoName: null,
            effort: 'M',
            target: { kind: 'plan_item', planId: 7, planItemId: 42 },
            href: '/plans',
          },
        ],
      }),
    );
    expect((wire.actions as Record<string, unknown>[])[0]).toMatchObject({
      effort: 'M',
      repo_id: null,
      target: { kind: 'plan_item', plan_id: 7, plan_item_id: 42 },
      href: '/plans',
    });
  });

  it('carries coverage counts onto the wire when the list is empty', () => {
    const wire = serializeTopActions(
      result({
        coverage: {
          basis: 'none',
          reposTotal: 2,
          reposMeasured: 0,
          reposNeverMeasured: 2,
          reposStale: 0,
          notices: [
            {
              repoId: 1,
              repoName: 'alpha',
              capability: 'depscan',
              state: 'failed',
              detail: 'boom',
            },
          ],
          unsupported: ['iac'],
          summary: 'Nothing has been measured yet.',
        },
      }),
    );
    expect(wire.coverage).toMatchObject({
      basis: 'none',
      repos_total: 2,
      repos_measured: 0,
      repos_never_measured: 2,
      repos_stale: 0,
      notices: [{ repo_id: 1, repo_name: 'alpha', capability: 'depscan', state: 'failed' }],
      unsupported: ['iac'],
    });
  });
});

// The deterministic top-actions source (W17-16).
//
// These run against a real Postgres because the three things most worth proving
// cannot be proved against fixtures: the tenant filter is in the SQL, the
// exclusions are in the SQL, and effective_risk is a `numeric` — which drizzle
// hands back as a STRING, so a fixture built from JS numbers sorts correctly
// while the product sorts '9.00' above '80.00'.
describeIfDb('collectTopActions (W17-16)', () => {
  let db: Database;
  let workspaceId: number;
  let otherWorkspaceId: number;
  /**
   * A workspace with a repository and NO scan runs at all.
   *
   * Workspaces A and B both have a succeeded scan run — findings need one — and
   * a succeeded run is a measurement, so neither can ever show `basis: 'none'`.
   * Asserting it there would have been asserting against a fixture that
   * contradicted its own comment.
   */
  let unmeasuredWorkspaceId: number;
  let repoId: number;
  let repoTwoId: number;
  let otherRepoId: number;
  const connectionIds: number[] = [];
  const repoIds: number[] = [];
  let scanRunId: number;
  let otherScanRunId: number;

  const NOW = new Date('2026-09-10T12:00:00.000Z');

  beforeAll(async () => {
    db = createDb(databaseUrl as string);

    const mkWorkspace = async (slug: string, name: string): Promise<number> => {
      const [ws] = await db
        .insert(core.workspaces)
        .values({ slug, name })
        .onConflictDoUpdate({ target: core.workspaces.slug, set: { name } })
        .returning();
      return ws!.id;
    };
    workspaceId = await mkWorkspace('w17-16-a', 'W17-16 A');
    otherWorkspaceId = await mkWorkspace('w17-16-b', 'W17-16 B');
    unmeasuredWorkspaceId = await mkWorkspace('w17-16-c', 'W17-16 C');

    const mkConnection = async (wsId: number, fp: string): Promise<number> => {
      const [c] = await db
        .insert(core.forgeConnections)
        .values({
          workspaceId: wsId,
          provider: 'github',
          authKind: 'pat',
          credentialCiphertext: Buffer.alloc(8),
          credentialIv: Buffer.alloc(12),
          keyVersion: 1,
          credentialFingerprint: fp,
          status: 'active',
        })
        .returning();
      connectionIds.push(c!.id);
      return c!.id;
    };

    const mkRepo = async (
      wsId: number,
      connId: number,
      forgeRepoId: string,
      name: string,
    ): Promise<number> => {
      await db.delete(core.repos).where(eq(core.repos.forgeRepoId, forgeRepoId));
      const [r] = await db
        .insert(core.repos)
        .values({
          workspaceId: wsId,
          connectionId: connId,
          forgeRepoId,
          org: 'acme',
          name,
          defaultBranch: 'main',
          isPrivate: false,
          isArchived: false,
          syncStatus: 'live',
          tier2Auto: false,
        })
        .returning();
      repoIds.push(r!.id);
      return r!.id;
    };

    const connA = await mkConnection(workspaceId, 'w17-16-fp-a');
    const connB = await mkConnection(otherWorkspaceId, 'w17-16-fp-b');
    // 'zulu' before 'alpha' on purpose: the repository NAME is a tie-break, so
    // the ids and the names must disagree or the test proves nothing.
    repoId = await mkRepo(workspaceId, connA, 'w17-16-repo-1', 'zulu');
    repoTwoId = await mkRepo(workspaceId, connA, 'w17-16-repo-2', 'alpha');
    otherRepoId = await mkRepo(otherWorkspaceId, connB, 'w17-16-repo-3', 'other');
    const connC = await mkConnection(unmeasuredWorkspaceId, 'w17-16-fp-c');
    await mkRepo(unmeasuredWorkspaceId, connC, 'w17-16-repo-4', 'never-synced');

    const mkScanRun = async (wsId: number, rId: number): Promise<number> => {
      const [run] = await db
        .insert(security.scanRuns)
        .values({
          workspaceId: wsId,
          repoId: rId,
          scannerKey: 'secrets',
          scannerVersion: '1.0.0',
          commitSha: 'abc123',
          trigger: 'manual',
          status: 'succeeded',
          startedAt: NOW,
          finishedAt: NOW,
        })
        .returning();
      return run!.id;
    };
    scanRunId = await mkScanRun(workspaceId, repoId);
    otherScanRunId = await mkScanRun(otherWorkspaceId, otherRepoId);
  });

  afterEach(async () => {
    await db.delete(read.findings).where(inArray(read.findings.repoId, repoIds));
    // In the hook, not at the end of the test body: a failing assertion would
    // otherwise leave the row behind and poison whatever runs next.
    // Scoped to this suite's repositories, like the two deletes above it: an
    // unscoped scannerKey predicate would clear every depscan run in the dev
    // database, not the one row the test inserted.
    await db
      .delete(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.scannerKey, 'depscan'),
          inArray(security.scanRuns.repoId, repoIds),
        ),
      );
    await db
      .delete(plansSchema.planItems)
      .where(inArray(plansSchema.planItems.workspaceId, [workspaceId, otherWorkspaceId]));
    await db
      .delete(plansSchema.improvementPlans)
      .where(inArray(plansSchema.improvementPlans.workspaceId, [workspaceId, otherWorkspaceId]));
  });

  afterAll(async () => {
    await db.delete(read.findings).where(inArray(read.findings.repoId, repoIds));
    await db.delete(security.scanRuns).where(inArray(security.scanRuns.repoId, repoIds));
    await db.delete(core.repos).where(inArray(core.repos.id, repoIds));
    await db.delete(core.forgeConnections).where(inArray(core.forgeConnections.id, connectionIds));
    await db.$client.end();
  });

  let seq = 0;
  async function addFinding(v: {
    workspaceId?: number;
    repoId?: number;
    scanRunId?: number;
    title?: string;
    status?: string;
    severity?: number;
    effectiveRisk?: string | null;
    experimental?: boolean;
  }): Promise<number> {
    seq += 1;
    const [row] = await db
      .insert(read.findings)
      .values({
        workspaceId: v.workspaceId ?? workspaceId,
        repoId: v.repoId ?? repoId,
        scanRunId: v.scanRunId ?? scanRunId,
        dimension: 'security',
        severity: v.severity ?? 3,
        confidence: 3,
        title: v.title ?? `finding ${seq}`,
        file: 'src/app.ts',
        lineStart: 1,
        lineEnd: 2,
        evidence: 'evidence',
        recommendation: 'fix it',
        tier: 1,
        dedupKey: `w17-16-${seq}`,
        status: v.status ?? 'open',
        effectiveRisk: v.effectiveRisk === undefined ? '50.00' : v.effectiveRisk,
        experimental: v.experimental ?? false,
      })
      .returning();
    return row!.id;
  }

  async function addPlanItem(v: {
    workspaceId?: number;
    rank?: number;
    catalogId?: string;
    status?: string;
    planStatus?: string;
    findingIds?: number[];
  }): Promise<number> {
    const wsId = v.workspaceId ?? workspaceId;
    const [plan] = await db
      .insert(plansSchema.improvementPlans)
      .values({
        workspaceId: wsId,
        repoIds: [wsId === workspaceId ? repoId : otherRepoId],
        window: '30d',
        catalogVersion: 'catalog.v1',
        status: v.planStatus ?? 'active',
      })
      .returning();
    const [item] = await db
      .insert(plansSchema.planItems)
      .values({
        workspaceId: wsId,
        planId: plan!.id,
        rank: v.rank ?? 1,
        catalogId: v.catalogId ?? 'review-coverage-low',
        source: 'metric',
        evidence: v.findingIds ? { findingIds: v.findingIds } : { metricKeys: ['M5'] },
        recommendation: 'Raise review coverage',
        effort: 'M',
        status: v.status ?? 'proposed',
        verifyCriterion: { metricKey: 'M5', op: 'gte', target: 0.8, windowDays: 30 },
      })
      .returning();
    return item!.id;
  }

  const run = async (wsId = workspaceId) => collectTopActions(db, wsId, { now: NOW });

  it('orders by priced risk read out of a numeric column', async () => {
    // 9.00 and 80.00. As STRINGS '9.00' > '80.00', so an uncoerced read puts
    // the smaller risk on top of the card — and no fixture would say so.
    const low = await addFinding({ effectiveRisk: '9.00' });
    const high = await addFinding({ effectiveRisk: '80.00' });
    const { actions } = await run();
    expect(actions.map((a) => a.id)).toEqual([`finding:${high}`, `finding:${low}`]);
  });

  it('is deterministic for the same title in two repositories', async () => {
    const zulu = await addFinding({ repoId, title: 'Hardcoded credential' });
    const alpha = await addFinding({ repoId: repoTwoId, title: 'Hardcoded credential' });
    const first = await run();
    const second = await run();
    expect(first.actions.map((a) => a.id)).toEqual(second.actions.map((a) => a.id));
    // 'alpha' before 'zulu' — the repository name decides it, and the higher id
    // coming first proves insertion order is not what is being read.
    expect(first.actions.map((a) => a.id)).toEqual([`finding:${alpha}`, `finding:${zulu}`]);
    expect(first.actions[0]?.repoName).toBe('alpha');
  });

  it('holds tenant isolation in both directions', async () => {
    const mine = await addFinding({});
    await addFinding({
      workspaceId: otherWorkspaceId,
      repoId: otherRepoId,
      scanRunId: otherScanRunId,
      effectiveRisk: '99.00',
    });
    const { actions } = await run();
    expect(actions.map((a) => a.id)).toEqual([`finding:${mine}`]);

    // And the other workspace sees only its own, despite the higher-ranked row
    // living over here.
    const theirs = await run(otherWorkspaceId);
    expect(theirs.actions).toHaveLength(1);
    expect(theirs.actions[0]?.id).not.toBe(`finding:${mine}`);
  });

  it('excludes dismissed, resolved, wont_fix and experimental findings', async () => {
    await addFinding({ status: 'dismissed' });
    await addFinding({ status: 'resolved' });
    // wont_fix is as settled as dismissed. The filter is an allowlist, so this
    // passes for the same reason the two the ticket names do.
    await addFinding({ status: 'wont_fix' });
    // A candidate rule's findings are excluded from org banners (W9-07).
    await addFinding({ experimental: true });
    const { actions, coverage } = await run();
    expect(actions).toEqual([]);
    expect(coverage).not.toBeNull();
  });

  it('excludes a plan item whose plan is archived, and one already done', async () => {
    await addPlanItem({ planStatus: 'archived' });
    await addPlanItem({ status: 'done' });
    const { actions } = await run();
    expect(actions).toEqual([]);
  });

  it('does not list a finding twice via a plan item that names it', async () => {
    const findingId = await addFinding({ effectiveRisk: '90.00' });
    await addPlanItem({ findingIds: [findingId] });
    const { actions } = await run();
    expect(actions.map((a) => a.id)).toEqual([`finding:${findingId}`]);
  });

  it('deep-links each action at the row it is actually about', async () => {
    const findingId = await addFinding({});
    const itemId = await addPlanItem({});
    const { actions } = await run();
    const found = actions.find((a) => a.kind === 'finding');
    expect(found?.href).toBe(`/findings?finding=${findingId}`);
    expect(found?.target).toEqual({ kind: 'finding', findingId, repoId });
    const item = actions.find((a) => a.kind === 'plan_item');
    expect(item?.target).toMatchObject({ kind: 'plan_item', planItemId: itemId });
    // No search param the plans route does not validate (W16-49).
    expect(item?.href).toBe('/plans');
  });

  it('returns at most three however many candidates exist', async () => {
    for (let i = 0; i < 8; i += 1) await addFinding({ effectiveRisk: `${90 - i}.00` });
    for (let i = 0; i < 5; i += 1) await addPlanItem({ rank: i + 1, catalogId: `entry-${i}` });
    const { actions } = await run();
    expect(actions).toHaveLength(3);
    // Two findings and one plan item — the per-kind cap, not whichever table
    // happened to have rows.
    expect(actions.filter((a) => a.kind === 'finding')).toHaveLength(2);
    expect(actions.filter((a) => a.kind === 'plan_item')).toHaveLength(1);
  });

  it('an empty list carries coverage state, not a clean bill of health', async () => {
    // The workspace whose repository has never been measured at all.
    const { actions, coverage } = await run(unmeasuredWorkspaceId);
    expect(actions).toEqual([]);
    expect(coverage).not.toBeNull();
    expect(coverage?.reposTotal).toBe(1);
    expect(coverage?.reposMeasured).toBe(0);
    // Never synced, so this must not read as "we looked and found nothing".
    expect(coverage?.basis).toBe('none');
    expect(coverage?.summary).toMatch(/not a clean result/i);
    // Reserved-but-unshipped capabilities are named rather than silently absent.
    expect(coverage?.unsupported).toContain('test_coverage');
  });

  it('an empty list over MEASURED repositories still reports what was measured', async () => {
    // The other half of the acceptance: silence after a real measurement is
    // reported as a measurement, never as a universal all-clear.
    const { actions, coverage } = await run();
    expect(actions).toEqual([]);
    expect(coverage?.basis).toBe('partial');
    expect(coverage?.reposMeasured).toBe(1);
    expect(coverage?.reposTotal).toBe(2);
    expect(coverage?.summary).toContain('1 of 2 repositories have been measured');
    expect(coverage?.summary).not.toMatch(/all clear|everything is fine|no issues/i);
  });

  it('a failed scan is an operational notice, never an action', async () => {
    await db.insert(security.scanRuns).values({
      workspaceId,
      repoId,
      scannerKey: 'depscan',
      scannerVersion: '1.0.0',
      commitSha: 'abc123',
      trigger: 'manual',
      status: 'failed',
      startedAt: NOW,
      finishedAt: NOW,
    });
    const { actions, coverage } = await run();
    expect(actions).toEqual([]);
    const notice = coverage?.notices.find((n) => n.capability === 'depscan');
    expect(notice?.state).toBe('failed');
    // An ingestion failure says something about us, not about their code.
    expect(coverage?.notices.every((n) => n.state !== 'open')).toBe(true);
  });

  it('omits coverage when there is something to do', async () => {
    await addFinding({});
    const { actions, coverage } = await run();
    expect(actions).toHaveLength(1);
    expect(coverage).toBeNull();
  });
});
