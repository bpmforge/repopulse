import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, facts, read } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_CALLS_TO_START,
  SCHEDULED_PASSES_PER_DAY,
  monthStart,
  runScheduleTick,
} from './ai-pass-scheduler.js';
import { digestOf, type PassEgress, type EgressDestination } from '../lib/ai-pass-egress.js';

// W19-12. The scheduler tick, against the real tables. The properties that matter:
// it only ever acts on an ENABLED, ACKNOWLEDGED schedule that is due; every refusal
// is recorded as a skipped pass with its reason; the monthly cap and the daily limit
// are hard; the routing having changed since the acknowledgement stops it; and it
// is strictly per workspace.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const local: EgressDestination = {
  provider_id: 1,
  provider_name: 'LM Studio',
  host: '10.0.0.5:1234',
  leaves_network: false,
  roles: ['security', 'triage'],
};
const hosted: EgressDestination = {
  provider_id: 2,
  provider_name: 'Hosted',
  host: 'api.example.com',
  leaves_network: true,
  roles: ['security'],
};
const egressOf = (localOnly: boolean, dests: EgressDestination[]): PassEgress => ({
  local_only: localOnly,
  destinations: dests,
  leaves_network: dests.some((d) => d.leaves_network),
  digest: digestOf(localOnly, dests),
  sentence: 'x',
});

describeIfLiveInfra('the AI-pass scheduler (W19-12)', () => {
  const db = createDb(databaseUrl as string);
  let WS = 0;
  let OTHER = 0;
  let REPO = 0;
  let OTHER_REPO = 0;
  let USER = 0;
  let IDENT = 0;
  let connectionId = 0;
  let current = egressOf(false, [local]);
  const NOW = new Date('2026-10-18T12:00:00Z');
  const enqueue = vi.fn(async () => {});
  const audit = vi.fn();

  const tick = (now = NOW) =>
    runScheduleTick({ db, enqueue, now: () => now, egress: async () => current, audit });

  async function clear() {
    for (const w of [WS, OTHER]) {
      await db.delete(read.aiPassRuns).where(eq(read.aiPassRuns.workspaceId, w));
      await db.delete(read.aiPassSchedules).where(eq(read.aiPassSchedules.workspaceId, w));
      await db.delete(read.aiPassSettings).where(eq(read.aiPassSettings.workspaceId, w));
      await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, w));
    }
  }

  async function ws(slug: string) {
    await db.insert(core.workspaces).values({ slug, name: slug }).onConflictDoNothing();
    return (
      await db
        .select({ id: core.workspaces.id })
        .from(core.workspaces)
        .where(eq(core.workspaces.slug, slug))
        .limit(1)
    )[0]!.id;
  }
  async function repoIn(workspaceId: number, name: string) {
    const [r] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: `w19-12-${name}`,
        org: 'w19-12',
        name,
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    return r!.id;
  }

  beforeAll(async () => {
    WS = await ws('w19-12-ws');
    OTHER = await ws('w19-12-other');
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
    const enc = credentials.encryptCredential('w19-12-token', Buffer.alloc(32, 7));
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId: WS,
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
    connectionId = conn!.id;
    REPO = await repoIn(WS, 'sched');
    OTHER_REPO = await repoIn(OTHER, 'sched-other');
    await db
      .insert(core.identities)
      .values({ workspaceId: WS, provider: 'github', forgeLogin: 'w19-12-dev', displayName: 'Dev' })
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
    await db
      .insert(core.identities)
      .values({
        workspaceId: OTHER,
        provider: 'github',
        forgeLogin: 'w19-12-dev',
        displayName: 'Dev',
      })
      .onConflictDoNothing();
    await clear();
  });
  afterAll(async () => {
    await clear();
    await db.delete(core.repos).where(eq(core.repos.id, REPO));
    await db.delete(core.repos).where(eq(core.repos.id, OTHER_REPO));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, WS));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, OTHER));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, OTHER));
    await db.$client.end();
  });
  beforeEach(async () => {
    await clear();
    enqueue.mockClear();
    audit.mockClear();
    current = egressOf(false, [local]);
  });

  async function schedule(over: Partial<typeof read.aiPassSchedules.$inferInsert> = {}) {
    const [s] = await db
      .insert(read.aiPassSchedules)
      .values({
        workspaceId: WS,
        repoId: REPO,
        enabled: true,
        frequency: 'weekly',
        scopeKind: 'paths',
        paths: ['src'],
        egressDigest: current.digest,
        egressAck: { destinations: current.destinations },
        enabledBy: USER,
        enabledAt: new Date(NOW.getTime() - 8 * 86_400_000),
        nextRunAt: new Date(NOW.getTime() - 60_000),
        ...over,
      })
      .returning();
    return s!;
  }
  const runsOf = (workspaceId = WS) =>
    db
      .select()
      .from(read.aiPassRuns)
      .where(eq(read.aiPassRuns.workspaceId, workspaceId))
      .orderBy(read.aiPassRuns.id);
  const schedOf = async (id: number) =>
    (await db.select().from(read.aiPassSchedules).where(eq(read.aiPassSchedules.id, id)))[0]!;

  it('does nothing when no schedule is enabled - strictly opt-in', async () => {
    await schedule({ enabled: false, egressDigest: null, enabledAt: null });
    const r = await tick();
    expect(r).toEqual({ considered: 0, started: 0, skipped: 0 });
    expect(await runsOf()).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('cannot even be stored as enabled without the acknowledgement', async () => {
    await expect(schedule({ egressDigest: null })).rejects.toThrow();
  });

  it('does nothing for a schedule that is not due yet', async () => {
    const s = await schedule({ nextRunAt: new Date(NOW.getTime() + 3_600_000) });
    expect(await tick()).toMatchObject({ considered: 0, started: 0 });
    expect((await schedOf(s.id)).lastRunAt).toBeNull();
  });

  it('starts a due paths pass exactly as a click would, marked as scheduled, and sets the next run', async () => {
    const s = await schedule();
    const r = await tick();
    expect(r).toMatchObject({ considered: 1, started: 1, skipped: 0 });
    const [run] = await runsOf();
    expect(run).toMatchObject({
      status: 'pending',
      trigger: 'scheduled',
      scheduleId: s.id,
      mode: 'paths',
      paths: ['src'],
      requestedBy: USER,
    });
    expect(enqueue).toHaveBeenCalledWith({ workspaceId: WS, runId: run!.id, maxCalls: 30 });
    const after = await schedOf(s.id);
    expect(after.lastRunAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.nextRunAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    );
    expect(audit).toHaveBeenCalledWith(
      'ai_pass.scheduled_started',
      expect.objectContaining({ schedule_id: s.id, run_id: run!.id }),
      WS,
    );
  });

  it('two overlapping ticks start it once', async () => {
    await schedule();
    await Promise.all([tick(), tick()]);
    expect((await runsOf()).filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('daily schedules come back in a day', async () => {
    const s = await schedule({ frequency: 'daily' });
    await tick();
    expect((await schedOf(s.id)).nextRunAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 86_400_000).toISOString(),
    );
  });

  describe('every refusal is a recorded skipped pass with its reason', () => {
    async function expectSkipped(code: string, nextInMs: number | null) {
      const run = (await runsOf()).find((r) => r.trigger === 'scheduled');
      expect(run).toMatchObject({ status: 'skipped', trigger: 'scheduled', reasonCode: code });
      expect(run!.reason).toBeTruthy();
      expect(enqueue).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        'ai_pass.scheduled_skipped',
        expect.objectContaining({ code }),
        WS,
      );
      return nextInMs;
    }

    it('another pass already running', async () => {
      const s = await schedule();
      await db
        .insert(read.aiPassRuns)
        .values({ workspaceId: WS, repoId: REPO, paths: ['x'], status: 'running' });
      await tick();
      const runs = await runsOf();
      expect(runs.find((r) => r.trigger === 'scheduled')).toMatchObject({
        status: 'skipped',
        reasonCode: 'active_pass',
      });
      // A transient refusal looks again in hours, not a whole week.
      const next = (await schedOf(s.id)).nextRunAt!.getTime() - NOW.getTime();
      expect(next).toBe(3 * 3_600_000);
    });

    it('no model configured', async () => {
      current = egressOf(false, []);
      await schedule({ egressDigest: 'whatever' });
      await tick();
      await expectSkipped('no_gateway', null);
    });

    it('local-only is on but a hosted link would be used - nothing is sent', async () => {
      current = egressOf(true, [local, hosted]);
      await schedule({ egressDigest: current.digest });
      await tick();
      await expectSkipped('local_only_forbids', null);
      expect((await runsOf()).find((r) => r.trigger === 'scheduled')!.reason).toMatch(
        /Nothing was sent/,
      );
    });

    it('the routing changed since the acknowledgement - it stops until re-acknowledged', async () => {
      const acknowledged = egressOf(false, [local]);
      await schedule({ egressDigest: acknowledged.digest });
      current = egressOf(false, [local, hosted]); // a hosted link was added afterwards
      await tick();
      await expectSkipped('routing_changed', null);
      expect((await runsOf()).find((r) => r.trigger === 'scheduled')!.reason).toMatch(
        /acknowledge where source is sent now/,
      );
    });

    it('the monthly call cap is used up - hard stop, even with the daily limit untouched', async () => {
      await db.insert(read.aiPassSettings).values({ workspaceId: WS, monthlyCallCap: 100 });
      await db.insert(read.aiPassRuns).values({
        workspaceId: WS,
        repoId: REPO,
        paths: ['x'],
        status: 'succeeded',
        calls: 100 - (MIN_CALLS_TO_START - 1),
        createdAt: new Date(NOW.getTime() - 86_400_000 * 2),
      });
      await schedule();
      await tick();
      await expectSkipped('cap_reached', null);
      expect((await runsOf()).at(-1)!.reason).toMatch(/monthly cap of 100 model calls/);
    });

    it('the daily pass limit', async () => {
      for (let i = 0; i < SCHEDULED_PASSES_PER_DAY; i++) {
        await db.insert(read.aiPassRuns).values({
          workspaceId: WS,
          repoId: REPO,
          paths: ['x'],
          status: 'succeeded',
          calls: 0,
          createdAt: new Date(NOW.getTime() - 3_600_000),
        });
      }
      await schedule();
      await tick();
      const last = (await runsOf()).at(-1)!;
      expect(last).toMatchObject({ status: 'skipped', reasonCode: 'daily_limit' });
    });

    it('a paths schedule with no paths', async () => {
      await schedule({ paths: [] });
      await tick();
      await expectSkipped('no_scope', null);
    });
  });

  it('the call limit for the pass is what is left of the month, when that is less than a full pass', async () => {
    await db.insert(read.aiPassSettings).values({ workspaceId: WS, monthlyCallCap: 25 });
    await db.insert(read.aiPassRuns).values({
      workspaceId: WS,
      repoId: REPO,
      paths: ['x'],
      status: 'succeeded',
      calls: 10,
      createdAt: monthStart(NOW),
    });
    await schedule();
    await tick();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ maxCalls: 15 }));
  });

  it('calls from last month do not count against this month', async () => {
    await db.insert(read.aiPassSettings).values({ workspaceId: WS, monthlyCallCap: 25 });
    await db.insert(read.aiPassRuns).values({
      workspaceId: WS,
      repoId: REPO,
      paths: ['x'],
      status: 'succeeded',
      calls: 25,
      createdAt: new Date(monthStart(NOW).getTime() - 3_600_000),
    });
    await schedule();
    await tick();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ maxCalls: 25 }));
  });

  describe('the new pull requests scope', () => {
    let seq = 0;
    async function pr(over: Partial<typeof facts.pullRequests.$inferInsert> = {}) {
      seq += 1;
      const [p] = await db
        .insert(facts.pullRequests)
        .values({
          workspaceId: WS,
          repoId: REPO,
          number: 100 + seq,
          forgePrId: `w19-12-pr-${seq}-${Math.random()}`,
          title: `PR ${seq}`,
          authorIdentityId: IDENT,
          state: 'open',
          isDraft: false,
          isBot: false,
          createdAt: NOW,
          updatedAt: new Date(NOW.getTime() - 3_600_000),
          baseRef: 'main',
          headSha: `head${seq}`.padEnd(40, '0'),
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          ...over,
        })
        .returning();
      return p!;
    }

    it('reviews the oldest open, non-draft pull request changed since opting in, and drains the rest', async () => {
      const s = await schedule({ scopeKind: 'new_pull_requests', paths: [] });
      const older = await pr({ updatedAt: new Date(NOW.getTime() - 7_200_000) });
      await pr({ updatedAt: new Date(NOW.getTime() - 3_600_000) });
      await pr({ isDraft: true });
      await pr({ state: 'closed' });
      await pr({ updatedAt: new Date(NOW.getTime() - 20 * 86_400_000) }); // before opting in
      await tick();
      const [run] = await runsOf();
      expect(run).toMatchObject({
        status: 'pending',
        trigger: 'scheduled',
        mode: 'pull_request',
        prNumber: older.number,
        headRef: older.headSha,
      });
      // More are waiting, so it comes back in an hour, not a week.
      const next = (await schedOf(s.id)).nextRunAt!.getTime() - NOW.getTime();
      expect(next).toBe(3_600_000);
    });

    it('does not review the same head twice, and says when there is nothing new', async () => {
      const s = await schedule({ scopeKind: 'new_pull_requests', paths: [] });
      const p = await pr();
      await db.insert(read.aiPassRuns).values({
        workspaceId: WS,
        repoId: REPO,
        paths: [],
        mode: 'pull_request',
        prNumber: p.number,
        headRef: p.headSha,
        status: 'succeeded',
        calls: 3,
        createdAt: new Date(NOW.getTime() - 1_800_000),
      });
      await tick();
      const last = (await runsOf()).at(-1)!;
      expect(last).toMatchObject({ status: 'skipped', reasonCode: 'no_new_pull_requests' });
      expect(enqueue).not.toHaveBeenCalled();
      // A pull request that gets a NEW head is reviewed again.
      await db
        .update(facts.pullRequests)
        .set({ headSha: 'newhead'.padEnd(40, '1'), updatedAt: new Date(NOW.getTime() - 60_000) })
        .where(eq(facts.pullRequests.id, p.id));
      await db
        .update(read.aiPassSchedules)
        .set({ nextRunAt: new Date(NOW.getTime() - 1000) })
        .where(eq(read.aiPassSchedules.id, s.id));
      await tick();
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });

  it('is strictly per workspace: another workspace never counts toward this one, nor blocks it', async () => {
    // The other workspace has used its whole month, has an active pass, and a schedule of its own.
    await db.insert(read.aiPassSettings).values({ workspaceId: OTHER, monthlyCallCap: 0 });
    await db.insert(read.aiPassRuns).values({
      workspaceId: OTHER,
      repoId: OTHER_REPO,
      paths: ['x'],
      status: 'running',
      calls: 9999,
    });
    await schedule();
    const r = await tick();
    expect(r).toMatchObject({ started: 1, skipped: 0 });
    expect((await runsOf()).filter((x) => x.trigger === 'scheduled')).toHaveLength(1);
    expect(await runsOf(OTHER)).toHaveLength(1); // still just its own running pass
  });
});
