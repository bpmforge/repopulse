import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@repopulse/shared';
import { BudgetedClient, type ForgeHttpResponse, type RequestExecutor } from './budgeted-client.js';
import { ForgeBudgetParkedError } from './errors.js';
import {
  cleanupFixture,
  createDb,
  databaseUrl,
  seedWorkspaceAndConnection,
  type SeededFixture,
} from './test-fixtures.js';

const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const ALLOWLIST = ['api.github.com'];

function jsonResponse(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): ForgeHttpResponse {
  return { status, headers, body };
}

describeIfLiveInfra('BudgetedClient (FR-FORGE-3/4, NFR-12)', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl as string);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  // FR-FORGE-3 acceptance: "simulated 100-remaining response ... no request
  // is emitted once budget floor is hit."
  describe('primary budget floor (AC2)', () => {
    let fixture: SeededFixture;

    beforeAll(async () => {
      fixture = await seedWorkspaceAndConnection(db, {
        workspaceSlug: 'w1-05-floor-test',
        forgeUserId: 'w1-05-floor-test-user',
      });
    });

    afterAll(async () => {
      await cleanupFixture(db, fixture);
    });

    it('parks backfill/reconcile at the floor and never dispatches; webhook/user still drain the reserve', async () => {
      let calls = 0;
      const executor: RequestExecutor = async () => {
        calls++;
        return jsonResponse(
          200,
          { 'x-ratelimit-remaining': '100', 'x-ratelimit-limit': '5000' },
          { ok: true },
        );
      };
      const client = new BudgetedClient({
        connectionId: fixture.connectionId,
        workspaceId: fixture.workspaceId,
        db,
        executor,
        allowlist: ALLOWLIST,
        floor: 100,
      });

      // First call is unseeded -> must go through to discover the limit.
      await client.request(
        { lane: 'backfill' },
        {
          method: 'GET',
          url: 'https://api.github.com/repos/acme/widgets/commits',
          family: 'commits',
        },
      );
      expect(calls).toBe(1);
      expect(client.primaryBudgetSnapshot().remaining).toBe(100);

      // Now at the floor: backfill/reconcile must park without dispatching.
      await expect(
        client.request(
          { lane: 'backfill' },
          {
            method: 'GET',
            url: 'https://api.github.com/repos/acme/widgets/commits',
            family: 'commits',
          },
        ),
      ).rejects.toBeInstanceOf(ForgeBudgetParkedError);
      await expect(
        client.request(
          { lane: 'reconcile' },
          {
            method: 'GET',
            url: 'https://api.github.com/repos/acme/widgets/commits',
            family: 'commits',
          },
        ),
      ).rejects.toBeInstanceOf(ForgeBudgetParkedError);
      expect(calls).toBe(1); // zero requests emitted below the floor

      // webhook/user may still drain the reserve.
      await client.request(
        { lane: 'webhook' },
        {
          method: 'GET',
          url: 'https://api.github.com/repos/acme/widgets/commits',
          family: 'commits',
        },
      );
      expect(calls).toBe(2);
    });
  });

  // FR-FORGE-4 acceptance: ETag 304 at zero primary charge; repeat-sync
  // consumes >=90% fewer rate-limit points than the first sync.
  describe('ETag cache + repeat-sync savings (AC3)', () => {
    let fixture: SeededFixture;

    beforeAll(async () => {
      fixture = await seedWorkspaceAndConnection(db, {
        workspaceSlug: 'w1-05-etag-savings-test',
        forgeUserId: 'w1-05-etag-savings-test-user',
      });
    });

    afterAll(async () => {
      await cleanupFixture(db, fixture);
    });

    it('serves 304s from cache and spends ~zero primary points on repeat sync', async () => {
      const REPO_COUNT = 10;
      // Simulated GitHub primary budget: starts at 5000, decrements by 1 per
      // real (200) response; conditional 304 responses never decrement it
      // (verified GitHub behavior, research §2) - the mock enforces that.
      let simulatedRemaining = 5000;
      const seenEtags = new Map<string, string>();

      const executor: RequestExecutor = async (req) => {
        const ifNoneMatch = req.headers['If-None-Match'];
        const known = seenEtags.get(req.url);
        if (ifNoneMatch && known && ifNoneMatch === known) {
          // conditional hit: zero primary charge, headers still report current remaining
          return jsonResponse(304, { 'x-ratelimit-remaining': String(simulatedRemaining) }, null);
        }
        simulatedRemaining -= 1;
        const etag = `"etag-for-${req.url}"`;
        seenEtags.set(req.url, etag);
        return jsonResponse(
          200,
          { 'x-ratelimit-remaining': String(simulatedRemaining), etag },
          { repo: req.url },
        );
      };

      const client = new BudgetedClient({
        connectionId: fixture.connectionId,
        workspaceId: fixture.workspaceId,
        db,
        executor,
        allowlist: ALLOWLIST,
        floor: 100,
      });

      const urls = Array.from(
        { length: REPO_COUNT },
        (_, i) => `https://api.github.com/repos/acme/repo-${i}`,
      );

      const remainingBeforeFirstSync = 5000;
      for (const url of urls) {
        const res = await client.request(
          { lane: 'backfill' },
          { method: 'GET', url, family: 'commits' },
        );
        expect(res.servedFromCache).toBe(false);
      }
      const remainingAfterFirstSync = client.primaryBudgetSnapshot().remaining as number;
      const firstSyncPointsSpent = remainingBeforeFirstSync - remainingAfterFirstSync;
      expect(firstSyncPointsSpent).toBe(REPO_COUNT);

      for (const url of urls) {
        const res = await client.request(
          { lane: 'backfill' },
          { method: 'GET', url, family: 'commits' },
        );
        expect(res.status).toBe(304);
        expect(res.servedFromCache).toBe(true);
        expect(res.body).toEqual({ repo: url });
      }
      const remainingAfterSecondSync = client.primaryBudgetSnapshot().remaining as number;
      const secondSyncPointsSpent = remainingAfterFirstSync - remainingAfterSecondSync;

      expect(secondSyncPointsSpent).toBe(0);
      const savingsRatio = 1 - secondSyncPointsSpent / firstSyncPointsSpent;
      expect(savingsRatio).toBeGreaterThanOrEqual(0.9);

      const metrics = client.metricsSnapshot();
      expect(metrics.forge304Total).toBe(REPO_COUNT);
    });
  });

  // 2026-10-27 walkthrough: a Gitea archive (200 + Last-Modified, binary body)
  // was cached as {} and the next fetch of it came back 304 with no bytes.
  describe('cache: false (source archives)', () => {
    let fixture: SeededFixture;

    beforeAll(async () => {
      fixture = await seedWorkspaceAndConnection(db, {
        workspaceSlug: 'w1-05-nocache-test',
        forgeUserId: 'w1-05-nocache-test-user',
      });
    });

    afterAll(async () => {
      await cleanupFixture(db, fixture);
    });

    it('sends no conditional headers and returns the bytes every time', async () => {
      const seen: Record<string, string>[] = [];
      const bytes = new Uint8Array([31, 139, 8, 0]);
      const executor: RequestExecutor = async (req) => {
        seen.push(req.headers);
        if (req.headers['If-Modified-Since'] || req.headers['If-None-Match']) {
          return { status: 304, headers: {}, body: null };
        }
        return {
          status: 200,
          headers: { 'last-modified': 'Tue, 27 Oct 2026 20:25:15 GMT' },
          body: bytes,
        };
      };
      const client = new BudgetedClient({
        connectionId: fixture.connectionId,
        workspaceId: fixture.workspaceId,
        db,
        executor,
        allowlist: ALLOWLIST,
      });
      const req = {
        method: 'GET' as const,
        url: 'https://api.github.com/repos/acme/app/archive/abc.tar.gz',
        family: 'commits' as const,
        cache: false,
      };
      for (let i = 0; i < 2; i++) {
        const res = await client.request({ lane: 'backfill' }, req);
        expect(res.status).toBe(200);
        expect(res.body).toBe(bytes);
      }
      for (const h of seen) {
        expect(h['If-Modified-Since']).toBeUndefined();
        expect(h['If-None-Match']).toBeUndefined();
      }
    });
  });

  // §3 retry policy + NFR-12 instrumentation.
  describe('retry policy + instrumentation (AC4)', () => {
    let fixture: SeededFixture;

    beforeAll(async () => {
      fixture = await seedWorkspaceAndConnection(db, {
        workspaceSlug: 'w1-05-retry-test',
        forgeUserId: 'w1-05-retry-test-user',
      });
    });

    afterAll(async () => {
      await cleanupFixture(db, fixture);
    });

    it('honors retry-after on a secondary 429 then succeeds', async () => {
      const sleeps: number[] = [];
      let attempt = 0;
      const executor: RequestExecutor = async () => {
        attempt++;
        if (attempt === 1) {
          return jsonResponse(429, { 'retry-after': '3' }, { message: 'secondary rate limit' });
        }
        return jsonResponse(200, { 'x-ratelimit-remaining': '4999' }, { ok: true });
      };
      const client = new BudgetedClient({
        connectionId: fixture.connectionId,
        workspaceId: fixture.workspaceId,
        db,
        executor,
        allowlist: ALLOWLIST,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      const res = await client.request(
        { lane: 'user' },
        { method: 'GET', url: 'https://api.github.com/repos/acme/widgets', family: 'commits' },
      );
      expect(res.status).toBe(200);
      expect(attempt).toBe(2);
      expect(sleeps).toEqual([3000]); // retry-after honored exactly
    });

    it('falls back to x-ratelimit-reset when retry-after is absent on a 403', async () => {
      const sleeps: number[] = [];
      let attempt = 0;
      const nowMs = 1_700_000_000_000;
      const executor: RequestExecutor = async () => {
        attempt++;
        if (attempt === 1) {
          return jsonResponse(
            403,
            { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowMs / 1000 + 5) },
            { message: 'rate limited' },
          );
        }
        return jsonResponse(200, { 'x-ratelimit-remaining': '5000' }, { ok: true });
      };
      const client = new BudgetedClient({
        connectionId: fixture.connectionId,
        workspaceId: fixture.workspaceId,
        db,
        executor,
        allowlist: ALLOWLIST,
        now: () => nowMs,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      const res = await client.request(
        { lane: 'user' },
        { method: 'GET', url: 'https://api.github.com/repos/acme/other', family: 'commits' },
      );
      expect(res.status).toBe(200);
      expect(sleeps).toEqual([5000]);
    });

    it('retries 5xx up to 3 times with jitter then gives up', async () => {
      let attempt = 0;
      const executor: RequestExecutor = async () => {
        attempt++;
        return jsonResponse(503, {}, { message: 'unavailable' });
      };
      const client = new BudgetedClient({
        connectionId: fixture.connectionId,
        workspaceId: fixture.workspaceId,
        db,
        executor,
        allowlist: ALLOWLIST,
        sleep: async () => {},
        jitter: () => 0.5,
      });

      const res = await client.request(
        { lane: 'user' },
        { method: 'GET', url: 'https://api.github.com/repos/acme/flaky', family: 'commits' },
      );
      expect(res.status).toBe(503);
      expect(attempt).toBe(4); // 1 original + 3 retries
    });

    it('exposes NFR-12 counters/gauges after a mix of traffic', async () => {
      const executor: RequestExecutor = async () =>
        jsonResponse(200, { 'x-ratelimit-remaining': '4000' }, { ok: true });
      const client = new BudgetedClient({
        connectionId: fixture.connectionId,
        workspaceId: fixture.workspaceId,
        db,
        executor,
        allowlist: ALLOWLIST,
      });
      await client.request(
        { lane: 'user' },
        { method: 'GET', url: 'https://api.github.com/repos/acme/metrics-check', family: 'issues' },
      );
      const snapshot = client.metricsSnapshot();
      expect(snapshot.requestsTotal['issues|user|200']).toBe(1);
      expect(snapshot.budgetRemaining).toBe(4000);
      expect(snapshot.pointsSpent.rest).toBeGreaterThan(0);
      expect(snapshot.queueDepth).toEqual({
        webhook: 0,
        user: 0,
        backfill: 0,
        scan: 0,
        reconcile: 0,
      });
    });
  });
});
