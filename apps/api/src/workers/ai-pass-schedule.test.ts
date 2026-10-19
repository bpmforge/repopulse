import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, facts, read } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import type { RoutingPolicy, T2Host } from '@repopulse/analysis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_SCHEDULE_ACK_VERSION,
  AI_SCHEDULE_SWEEP_JOB,
  isDue,
  monthStart,
  nextDueAt,
  nonLocalConnections,
  sweepSchedules,
  withScheduleSweep,
  type ScheduleSweepDeps,
} from './ai-pass-schedule.js';
import { AI_PASSES_PER_DAY } from './ai-pass-processor.js';

// W19-12. Scheduled AI passes: the sweep only starts ordinary passes for
// repositories whose owner turned a schedule on and acknowledged it, and every
// due schedule that does not start a pass leaves a skipped run saying why.

const lan: T2Host = {
  baseUrl: 'http://192.168.1.20:1234/v1',
  modelSlot: 'qwen',
  name: 'LM Studio',
};
const cloud: T2Host = {
  baseUrl: 'https://api.example-models.test/v1',
  modelSlot: 'big',
  name: 'Hosted',
};

describe('schedule arithmetic (W19-12)', () => {
  const now = new Date('2026-10-19T12:00:00Z');

  it('a never-run schedule is due now; a weekly one is due a week after it last ran, less the sweep slack', () => {
    expect(isDue({ cadence: 'weekly', lastScheduledAt: null }, now)).toBe(true);
    const last = new Date('2026-10-14T12:00:00Z');
    expect(isDue({ cadence: 'weekly', lastScheduledAt: last }, now)).toBe(false);
    expect(nextDueAt({ cadence: 'weekly', lastScheduledAt: last }, now).toISOString()).toBe(
      '2026-10-21T11:00:00.000Z',
    );
    expect(
      isDue({ cadence: 'daily', lastScheduledAt: new Date('2026-10-18T13:00:00Z') }, now),
    ).toBe(true);
    expect(
      isDue({ cadence: 'daily', lastScheduledAt: new Date('2026-10-18T13:30:00Z') }, now),
    ).toBe(false);
  });

  it('the monthly cap counts from the first of the UTC month', () => {
    expect(monthStart(now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('names every connection a pass could reach that is off the network', () => {
    expect(nonLocalConnections([lan], undefined)).toEqual([]);
    expect(nonLocalConnections([lan, cloud], undefined)).toEqual(['Hosted']);
    // Local-only on: the default pool drops the hosted connection, as the gateway does.
    expect(nonLocalConnections([lan, cloud], { localOnly: true, chains: {} })).toEqual([]);
    // A role routed to a hosted connection is reachable whatever the pool says.
    const routed: RoutingPolicy = {
      localOnly: false,
      chains: { triage: [{ host: cloud, providerName: 'Hosted' }] },
    };
    expect(nonLocalConnections([lan], routed)).toEqual(['Hosted']);
  });

  it('the sweep job runs the sweep; every other job on the queue is a pass', async () => {
    const seen: string[] = [];
    const proc = withScheduleSweep(
      async () => {
        seen.push('sweep');
        return [];
      },
      async () => {
        seen.push('pass');
        return 'ok';
      },
    );
    await proc({ name: AI_SCHEDULE_SWEEP_JOB } as never);
    await proc({ name: 'ai.pass' } as never);
    expect(seen).toEqual(['sweep', 'pass']);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

describeIfLiveInfra('the schedule sweep (W19-12)', () => {
  const db = createDb(databaseUrl as string);
  let WS = 0;
  let OTHER = 0;
  let REPO = 0;
  let OTHER_REPO = 0;
  let USER = 0;
  let IDENT = 0;
  const connIds: number[] = [];
  const NOW = new Date('2026-10-19T12:00:00Z');

  async function clear() {
    for (const w of [WS, OTHER]) {
      if (!w) continue;
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, w));
      await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, w));
    }
    if (REPO) await db.delete(facts.commits).where(eq(facts.commits.repoId, REPO));
  }

  async function workspace(slug: string): Promise<number> {
    await db.insert(core.workspaces).values({ slug, name: slug }).onConflictDoNothing();
    return (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
  }

  async function repo(workspaceId: number, forgeRepoId: string): Promise<number> {
    const enc = credentials.encryptCredential('w19-12-fixture-token', Buffer.alloc(32, 7));
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: core.forgeConnections.id });
    connIds.push(conn!.id);
    const [r] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId,
        org: 'w19-12',
        name: forgeRepoId,
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .onConflictDoNothing()
      .returning({ id: core.repos.id });
    return (
      r?.id ??
      (
        await db
          .select({ id: core.repos.id })
          .from(core.repos)
          .where(
            and(eq(core.repos.workspaceId, workspaceId), eq(core.repos.forgeRepoId, forgeRepoId)),
          )
          .limit(1)
      )[0]!.id
    );
  }

  async function schedule(
    over: Partial<typeof read.aiPassSchedules.$inferInsert> = {},
  ): Promise<number> {
    const [row] = await db
      .insert(read.aiPassSchedules)
      .values({
        workspaceId: WS,
        repoId: REPO,
        enabled: true,
        scope: 'paths',
        paths: ['src'],
        cadence: 'weekly',
        monthlyCap: 4,
        requireLocal: true,
        acknowledgedBy: USER,
        acknowledgedAt: NOW,
        ackVersion: AI_SCHEDULE_ACK_VERSION,
        ...over,
      })
      .returning({ id: read.aiPassSchedules.id });
    return row!.id;
  }

  const enqueued: { workspaceId: number; runId: number }[] = [];
  function deps(over: Partial<ScheduleSweepDeps> = {}): ScheduleSweepDeps {
    return {
      db,
      gatewayFor: async () => ({ hosts: [lan] }),
      enqueue: async (workspaceId, runId) => {
        enqueued.push({ workspaceId, runId });
      },
      now: () => NOW,
      ...over,
    };
  }

  const runsOf = (workspaceId = WS) =>
    db
      .select()
      .from(read.aiPassRuns)
      .where(eq(read.aiPassRuns.workspaceId, workspaceId))
      .orderBy(read.aiPassRuns.id);

  beforeAll(async () => {
    WS = await workspace('w19-12-ws');
    OTHER = await workspace('w19-12-other');
    await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: 'w19-12@example.test',
        login: 'w19-12',
        email: 'w19-12@example.test',
      })
      .onConflictDoNothing();
    USER = (
      await db
        .select({ id: core.users.id })
        .from(core.users)
        .where(eq(core.users.authSubject, 'w19-12@example.test'))
        .limit(1)
    )[0]!.id;
    REPO = await repo(WS, 'w19-12-repo');
    OTHER_REPO = await repo(OTHER, 'w19-12-other-repo');
    await db
      .insert(core.identities)
      .values({ workspaceId: WS, provider: 'github', forgeLogin: 'w19-12-dev', displayName: 'dev' })
      .onConflictDoNothing();
    IDENT = (
      await db
        .select({ id: core.identities.id })
        .from(core.identities)
        .where(
          and(eq(core.identities.workspaceId, WS), eq(core.identities.forgeLogin, 'w19-12-dev')),
        )
        .limit(1)
    )[0]!.id;
  });
  beforeEach(async () => {
    await clear();
    enqueued.length = 0;
  });
  afterAll(async () => {
    await clear();
    await db.delete(core.identities).where(eq(core.identities.id, IDENT));
    await db.delete(core.repos).where(eq(core.repos.id, REPO));
    await db.delete(core.repos).where(eq(core.repos.id, OTHER_REPO));
    for (const id of connIds)
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, id));
  });

  it('starts nothing for a schedule that is off, and nothing twice in one period', async () => {
    await schedule({ enabled: false });
    expect(await sweepSchedules(deps())).toEqual([]);
    expect(await runsOf()).toEqual([]);

    await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, WS));
    const id = await schedule();
    const first = await sweepSchedules(deps());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ scheduleId: id, status: 'started' });
    const [run] = await runsOf();
    expect(run).toMatchObject({
      trigger: 'schedule',
      scheduleId: id,
      status: 'pending',
      mode: 'paths',
      paths: ['src'],
      requestedBy: null,
    });
    expect(enqueued).toEqual([{ workspaceId: WS, runId: run!.id }]);
    // Same hour again: not due, and no second record.
    expect(await sweepSchedules(deps())).toEqual([]);
    expect(await runsOf()).toHaveLength(1);
  });

  it('an enabled schedule cannot exist without its acknowledgement', async () => {
    await expect(
      db.insert(read.aiPassSchedules).values({ workspaceId: WS, repoId: REPO, enabled: true }),
    ).rejects.toThrow();
  });

  it('local-only: skipped, naming the hosted connection; allowed when the schedule permits hosted models', async () => {
    await schedule();
    const out = await sweepSchedules(deps({ gatewayFor: async () => ({ hosts: [lan, cloud] }) }));
    expect(out[0]).toMatchObject({ status: 'skipped', code: 'not_local' });
    const [skipped] = await runsOf();
    expect(skipped).toMatchObject({
      status: 'skipped',
      reasonCode: 'not_local',
      trigger: 'schedule',
    });
    expect(skipped!.reason).toContain('Hosted');
    expect(enqueued).toEqual([]);

    await clear();
    await schedule({ requireLocal: false });
    const ok = await sweepSchedules(deps({ gatewayFor: async () => ({ hosts: [lan, cloud] }) }));
    expect(ok[0]).toMatchObject({ status: 'started' });
  });

  it('no model configured: a skipped run that says so', async () => {
    await schedule();
    const out = await sweepSchedules(deps({ gatewayFor: async () => null }));
    expect(out[0]).toMatchObject({ status: 'skipped', code: 'no_gateway' });
    expect((await runsOf())[0]!.reason).toContain('Admin → Models');
  });

  it('the monthly cap counts started scheduled passes only, and a capped run is recorded', async () => {
    const id = await schedule({ monthlyCap: 2 });
    for (let i = 0; i < 2; i++) {
      await db.insert(read.aiPassRuns).values({
        workspaceId: WS,
        repoId: REPO,
        trigger: 'schedule',
        scheduleId: id,
        paths: ['src'],
        status: 'succeeded',
        createdAt: new Date('2026-10-05T00:00:00Z'),
      });
    }
    // Skips, last month's runs and manual runs do not count against it.
    await db.insert(read.aiPassRuns).values([
      {
        workspaceId: WS,
        repoId: REPO,
        trigger: 'schedule',
        scheduleId: id,
        paths: [],
        status: 'skipped',
        createdAt: new Date('2026-10-06T00:00:00Z'),
      },
      {
        workspaceId: WS,
        repoId: REPO,
        trigger: 'schedule',
        scheduleId: id,
        paths: [],
        status: 'succeeded',
        createdAt: new Date('2026-09-28T00:00:00Z'),
      },
    ]);
    const out = await sweepSchedules(deps());
    expect(out[0]).toMatchObject({ status: 'skipped', code: 'monthly_cap' });

    await db
      .update(read.aiPassSchedules)
      .set({ monthlyCap: 3, lastScheduledAt: null })
      .where(eq(read.aiPassSchedules.id, id));
    expect((await sweepSchedules(deps()))[0]).toMatchObject({ status: 'started' });
  });

  it('one active pass per repository: a running pass makes the scheduled one a recorded skip', async () => {
    await schedule();
    await db.insert(read.aiPassRuns).values({
      workspaceId: WS,
      repoId: REPO,
      paths: ['lib'],
      status: 'running',
      createdAt: NOW,
    });
    const out = await sweepSchedules(deps());
    expect(out[0]).toMatchObject({ status: 'skipped', code: 'already_running' });
    expect(enqueued).toEqual([]);
  });

  it("the workspace's daily limit applies to scheduled passes too", async () => {
    await schedule();
    for (let i = 0; i < AI_PASSES_PER_DAY; i++) {
      await db.insert(read.aiPassRuns).values({
        workspaceId: WS,
        repoId: REPO,
        paths: ['lib'],
        status: 'succeeded',
        createdAt: new Date(NOW.getTime() - 60_000),
      });
    }
    const out = await sweepSchedules(deps());
    expect(out[0]).toMatchObject({ status: 'skipped', code: 'daily_limit' });
  });

  describe('new commits', () => {
    async function commit(sha: string, minutesAgo: number, isMerge = false) {
      const at = new Date(NOW.getTime() - minutesAgo * 60_000);
      await db.insert(facts.commits).values({
        workspaceId: WS,
        repoId: REPO,
        sha,
        authorIdentityId: IDENT,
        committerIdentityId: IDENT,
        authoredAt: at,
        committedAt: at,
        messageHead: 'x',
        isRevertHeuristic: false,
        isMerge,
      });
    }
    const sha = (i: number) => `${i.toString(16).padStart(2, '0')}`.repeat(20);

    it('reviews the newest commits as a range, then records "nothing new" until more arrive', async () => {
      // Fourteen commits, oldest first: the pass takes the newest ten.
      for (let i = 0; i < 14; i++) await commit(sha(i + 1), 1000 - i * 10);
      const id = await schedule({ scope: 'new_commits', paths: [] });
      const out = await sweepSchedules(deps());
      expect(out[0]).toMatchObject({ status: 'started' });
      const [run] = await runsOf();
      expect(run).toMatchObject({
        mode: 'commit_range',
        baseRef: sha(4),
        headRef: sha(14),
        trigger: 'schedule',
      });
      expect(run!.reason).toBeNull();
      const [s] = await db
        .select()
        .from(read.aiPassSchedules)
        .where(eq(read.aiPassSchedules.id, id));
      expect(s!.lastHeadSha).toBe(sha(14));

      // A week later with nothing new.
      await db
        .update(read.aiPassRuns)
        .set({ status: 'succeeded' })
        .where(eq(read.aiPassRuns.id, run!.id));
      const later = () => new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
      const again = await sweepSchedules(deps({ now: later }));
      expect(again[0]).toMatchObject({ status: 'skipped', code: 'nothing_new' });
    });

    it('more new commits than a pass reviews: the newest are taken and the run says how many were left', async () => {
      for (let i = 0; i < 14; i++) await commit(sha(i + 1), 1000 - i * 10);
      await schedule({ scope: 'new_commits', paths: [], lastHeadSha: sha(1) });
      await sweepSchedules(deps());
      const [run] = await runsOf();
      expect(run).toMatchObject({ baseRef: sha(4), headRef: sha(14) });
      expect(run!.reason).toContain('3 older new commits were not reviewed');
    });

    it('a repository with no commits: nothing new, recorded', async () => {
      await schedule({ scope: 'new_commits', paths: [] });
      const out = await sweepSchedules(deps());
      expect(out[0]).toMatchObject({ status: 'skipped', code: 'nothing_new' });
    });
  });

  it('tenancy: each run lands in its own schedule’s workspace', async () => {
    await schedule();
    await db.insert(read.aiPassSchedules).values({
      workspaceId: OTHER,
      repoId: OTHER_REPO,
      enabled: true,
      scope: 'paths',
      paths: ['app'],
      acknowledgedBy: USER,
      acknowledgedAt: NOW,
      ackVersion: AI_SCHEDULE_ACK_VERSION,
    });
    const asked: number[] = [];
    await sweepSchedules(
      deps({
        gatewayFor: async (w) => {
          asked.push(w);
          return { hosts: [lan] };
        },
      }),
    );
    expect(asked.sort()).toEqual([WS, OTHER].sort());
    expect((await runsOf(WS)).map((r) => r.repoId)).toEqual([REPO]);
    expect((await runsOf(OTHER)).map((r) => r.repoId)).toEqual([OTHER_REPO]);
  });
});
