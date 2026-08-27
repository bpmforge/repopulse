import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, createDb, security } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { SCANNER_DEFAULTS, isEnabled, listScanners } from '@repopulse/security';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import runRoutes, { runWindowKey } from './index.js';
import errorEnvelopePlugin from '../../plugins/error-envelope.js';

// W16-10 (F15). Nothing in this product could be started by hand: every scan and
// sync was cron-driven, so a fresh install looked identical to a broken one
// until the following Sunday.
//
// The two properties worth testing are not "it enqueues":
//
//   pressing twice must not start twice
//   a spent forge budget must REFUSE, not queue a job that can only fail

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const CSRF = { 'x-requested-with': 'repopulse' };
const WS_SLUG = 'w16-10-runs';
const USER_SUBJECT = 'w16-10-runs@example.com';
const FORGE_REPO_ID = 'w16-10-runs-repo';

describeIfLiveInfra('run it now (W16-10)', () => {
  let app: FastifyInstance;
  const db = createDb(databaseUrl as string);
  const added: { name: string; data: unknown; jobId: string }[] = [];
  // Models BullMQ's actual contract: adding with an existing jobId returns the
  // EXISTING job rather than creating a second one. That behaviour is the whole
  // double-start guard, so a stub that ignored it would test nothing.
  const existing = new Map<string, { id: string; state: string }>();
  let repoId = 0;
  let workspaceId = 0;
  let userId = 0;
  let connectionId = 0;

  const fakeQueue = {
    // Models BullMQ's actual contract in the one way that matters: `getJob`
    // answers for an id already taken, and `add` with a taken id is a no-op
    // returning something indistinguishable from a fresh job. A stub whose
    // `add` reported which happened would let a route pass that cannot work.
    getJob: vi.fn(async (jobId: string) => existing.get(jobId)),
    add: vi.fn(async (name: string, data: unknown, opts: { jobId: string }) => {
      if (existing.has(opts.jobId)) return { id: opts.jobId };
      existing.set(opts.jobId, { id: opts.jobId, state: 'waiting' });
      added.push({ name, data, jobId: opts.jobId });
      return { id: opts.jobId };
    }),
    close: async () => {},
  } as unknown as Queue;

  beforeAll(async () => {
    // FULLY OWN FIXTURES. Three attempts got here:
    //
    //   reading whatever `pnpm seed` left → passed or failed on FILE ORDER,
    //     because sibling suites delete users in their cleanup;
    //   reseeding to compensate → broke four other suites, since seedWarehouse
    //     recreates repos with fresh ids that they were still holding;
    //   reusing the seeded repo read-only → still failed, because some suite
    //     clears `repos` outright partway through a full run.
    //
    // So this file builds its own workspace → user → connection → repo and
    // removes exactly those rows again. repos.connection_id is NOT NULL, which
    // is why a fixture repo drags a forge connection along with it.
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: WS_SLUG, name: 'W16-10 runs' })
      .onConflictDoNothing()
      .returning({ id: core.workspaces.id });
    workspaceId =
      ws?.id ??
      (
        await db
          .select({ id: core.workspaces.id })
          .from(core.workspaces)
          .where(eq(core.workspaces.slug, WS_SLUG))
          .limit(1)
      )[0]!.id;

    const [u] = await db
      .insert(core.users)
      .values({
        authProvider: 'local',
        authSubject: USER_SUBJECT,
        login: 'w16-10-runs',
        email: USER_SUBJECT,
      })
      .onConflictDoNothing()
      .returning({ id: core.users.id });
    userId =
      u?.id ??
      (
        await db
          .select({ id: core.users.id })
          .from(core.users)
          .where(eq(core.users.authSubject, USER_SUBJECT))
          .limit(1)
      )[0]!.id;

    const enc = credentials.encryptCredential('w16-10-fixture-token', Buffer.alloc(32, 3));
    const [c] = await db
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
        createdBy: userId,
      })
      .returning({ id: core.forgeConnections.id });
    connectionId = c!.id;

    const [r] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: FORGE_REPO_ID,
        org: 'w16-10',
        name: 'runs',
        defaultBranch: 'main',
        isPrivate: false,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning({ id: core.repos.id });
    repoId = r!.id;

    // NO repo_scanner_config ROWS, deliberately (W16-20).
    //
    // The previous version of this file inserted `semgrep, enabled: true` here,
    // and that single row is what made the feature look green while it was
    // dead: with a row present the route's row-reading query found something.
    // Every repository on a fresh install has NO rows and falls back to
    // SCANNER_DEFAULTS, which is the state that must be covered.

    app = Fastify();
    await app.register(errorEnvelopePlugin);
    app.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: WS_SLUG, name: 'W16-10 runs' };
      request.role = 'admin';
      (request as { session?: { get: (k: string) => unknown } }).session = {
        get: (k: string) => (k === 'userId' ? userId : undefined),
      };
    });
    await app.register(runRoutes, { db, queueFor: () => fakeQueue });
    await app.ready();
  });

  afterAll(async () => {
    // Defensive: if beforeAll threw, `app` was never assigned and an unguarded
    // close buries the real error under a TypeError.
    await app?.close();
    // Reverse order of creation — every row here is referenced by the one above.
    if (repoId) {
      await db
        .delete(security.repoScannerConfig)
        .where(eq(security.repoScannerConfig.repoId, repoId));
      await db.delete(core.repos).where(eq(core.repos.id, repoId));
    }
    if (connectionId)
      await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    if (userId) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, userId));
      await db.delete(core.users).where(eq(core.users.id, userId));
    }
    if (workspaceId) await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  beforeEach(() => {
    added.length = 0;
    existing.clear();
    vi.clearAllMocks();
  });

  it('starts the default-enabled scanners on a repo with NO config rows', async () => {
    // The fresh-install state. Before W16-20 this answered "Nothing to run"
    // while the coverage table showed four scanners as enabled.
    const res = await app.inject({
      method: 'POST',
      url: `/repos/${repoId}/scan`,
      headers: CSRF,
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().started.length, 'defaults must be honoured with no rows').toBeGreaterThan(0);
    // Exactly the set the coverage table calls enabled — same helper, so the
    // two cannot disagree again.
    const expected = [
      ...new Set([...listScanners().map((s) => s.key), ...SCANNER_DEFAULTS.map((d) => d.key)]),
    ].filter((key) => isEnabled(key, undefined));
    expect([...res.json().started].sort()).toEqual([...expected].sort());
    expect(added[0]?.data).toMatchObject({ repoId, trigger: 'manual' });
  });

  it('pressing twice does not start twice', async () => {
    // Absorbed by the queue's own id semantics rather than by a flag in the
    // route — a second API replica would not share such a flag.
    const first = await app.inject({
      method: 'POST',
      url: `/repos/${repoId}/scan`,
      headers: CSRF,
      payload: {},
    });
    const enqueuedAfterFirst = added.length;
    expect(enqueuedAfterFirst).toBeGreaterThan(0);

    const second = await app.inject({
      method: 'POST',
      url: `/repos/${repoId}/scan`,
      headers: CSRF,
      payload: {},
    });

    // The SECOND press adds nothing — the count is unchanged.
    expect(added).toHaveLength(enqueuedAfterFirst);
    // And the person is told which happened — "already running" and "started"
    // are different news.
    expect(second.json().started).toEqual([]);
    expect([...second.json().already_running].sort()).toEqual([...first.json().started].sort());
  });

  it('records the request id and the actor on the job, so a failure traces back to the click', async () => {
    // W16-18. job_failure stores the whole payload as jsonb, so both land in the
    // dead-letter ledger with no migration — and "I pressed Run scans and
    // nothing happened" becomes a row someone can find. Without it a failed job
    // is anonymous: the queue knows what ran, nothing knows who asked.
    await app.inject({ method: 'POST', url: `/repos/${repoId}/scan`, headers: CSRF, payload: {} });

    const payload = added[0]?.data as { requestId?: string; requestedBy?: number };
    expect(payload.requestId, 'the request id must reach the job').toBeTruthy();
    expect(payload.requestedBy).toBe(userId);
  });

  it('refuses a scanner this repository has explicitly disabled', async () => {
    // Running one because someone pressed a general button would quietly undo a
    // deliberate decision that has an audit row behind it. Needs an EXPLICIT
    // row now: with defaults honoured, "no row" no longer means disabled, so
    // asserting against an absent row would prove nothing.
    await db
      .insert(security.repoScannerConfig)
      .values({ workspaceId, repoId, scannerKey: 'semgrep', enabled: false })
      .onConflictDoUpdate({
        target: [
          security.repoScannerConfig.workspaceId,
          security.repoScannerConfig.repoId,
          security.repoScannerConfig.scannerKey,
        ],
        set: { enabled: false },
      });

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/repos/${repoId}/scan`,
        headers: CSRF,
        payload: { scanner_key: 'semgrep' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toMatch(/not enabled/i);

      // And a stored `false` must beat the default in the general run too.
      const all = await app.inject({
        method: 'POST',
        url: `/repos/${repoId}/scan`,
        headers: CSRF,
        payload: {},
      });
      expect(all.json().started).not.toContain('semgrep');
    } finally {
      await db
        .delete(security.repoScannerConfig)
        .where(eq(security.repoScannerConfig.repoId, repoId));
    }
  });

  it('404s for a repository outside the workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/repos/999999999/scan',
      headers: CSRF,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  describe('sync', () => {
    it('queues a delta sync', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/repos/${repoId}/sync`,
        headers: CSRF,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().started).toBe(true);
      expect(added[0]?.data).toMatchObject({ repoId, trigger: 'manual' });
    });

    it('refuses when the forge budget is spent, rather than queueing a doomed job', async () => {
      // Law 7. A job queued against a spent budget fails an hour later, and
      // nothing connects that failure back to this click.
      const [before] = await db
        .select({ status: core.repos.syncStatus })
        .from(core.repos)
        .where(eq(core.repos.id, repoId))
        .limit(1);
      await db
        .update(core.repos)
        .set({ syncStatus: 'paused_budget' })
        .where(eq(core.repos.id, repoId));

      try {
        const res = await app.inject({
          method: 'POST',
          url: `/repos/${repoId}/sync`,
          headers: CSRF,
        });
        expect(res.statusCode).toBe(429);
        expect(res.json().detail).toMatch(/rate-limit window resets/i);
        expect(added).toHaveLength(0);
      } finally {
        await db
          .update(core.repos)
          .set({ syncStatus: before?.status ?? 'live' })
          .where(eq(core.repos.id, repoId));
      }
    });
  });

  it('says the queue is unavailable rather than pretending it started', async () => {
    const noQueue = Fastify();
    await noQueue.register(errorEnvelopePlugin);
    noQueue.addHook('onRequest', async (request) => {
      request.workspace = { id: workspaceId, slug: 't', name: 't' };
      request.role = 'admin';
      (request as { session?: { get: (k: string) => unknown } }).session = { get: () => 1 };
    });
    // No redisUrl and no injected queue: exactly a deployment whose API cannot
    // reach Redis.
    await noQueue.register(runRoutes, { db });
    await noQueue.ready();

    const res = await noQueue.inject({
      method: 'POST',
      url: `/repos/${repoId}/scan`,
      headers: CSRF,
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    await noQueue.close();
  });
});

describe('the manual-run dedup window', () => {
  it('collapses two presses inside five minutes and separates them after', () => {
    const t = 1_700_000_000_000;
    expect(runWindowKey(t)).toBe(runWindowKey(t + 60_000));
    expect(runWindowKey(t)).not.toBe(runWindowKey(t + 6 * 60_000));
  });
});
