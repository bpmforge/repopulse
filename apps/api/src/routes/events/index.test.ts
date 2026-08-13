import 'dotenv/config';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { publishSyncEvent, syncEventsChannel, type SyncStreamEvent } from '@repopulse/ingest';
import { formatSseFrame } from './index.js';

const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = redisUrl ? describe : describe.skip;

describe('SSE frame formatting (API_DESIGN §3)', () => {
  it('emits an event:/data: frame with the typed event name', () => {
    const frame = formatSseFrame({ type: 'sync.progress', data: { repoId: 3, pct: 40 } });
    expect(frame).toBe(
      'event: sync.progress\ndata: {"type":"sync.progress","data":{"repoId":3,"pct":40}}\n\n',
    );
  });
});

describeIfLiveInfra('sync event pub/sub relay (worker → api, NFR-10)', () => {
  const pub = new Redis(redisUrl as string);
  const sub = new Redis(redisUrl as string);

  afterAll(async () => {
    await pub.quit();
    await sub.quit();
  });

  it('a published sync event arrives on the workspace channel and formats to a frame', async () => {
    const workspaceId = 999_001;
    const received = new Promise<SyncStreamEvent>((resolve) => {
      sub.on('message', (_ch, msg) => resolve(JSON.parse(msg) as SyncStreamEvent));
    });
    await sub.subscribe(syncEventsChannel(workspaceId));
    await publishSyncEvent(pub, workspaceId, { type: 'sync.done', data: { repoId: 5 } });

    const event = await received;
    expect(event).toEqual({ type: 'sync.done', data: { repoId: 5 } });
    expect(formatSseFrame(event)).toContain('event: sync.done');
  });
  it('a subscriber on one workspace channel never receives another workspace event', async () => {
    // This test EXISTS BECAUSE /api/v1/events is skipped by the W1-07 tenancy
    // route-walker: inject() hangs forever on a socket-hijacking route, so the
    // sweep cannot cover it. Skipping a route without replacing its coverage
    // would be a silent hole in the tenancy guarantee (NFR-4), so the isolation
    // it can no longer prove generically is proven specifically here.
    const mine = 999_101;
    const theirs = 999_102;
    const isolated = new Redis(redisUrl as string);
    const seen: SyncStreamEvent[] = [];
    isolated.on('message', (_ch, msg) => seen.push(JSON.parse(msg) as SyncStreamEvent));
    await isolated.subscribe(syncEventsChannel(mine));

    // Publish to the OTHER workspace only.
    await publishSyncEvent(pub, theirs, { type: 'sync.done', data: { repoId: 42 } });
    // Then to mine, as a delivery barrier: once this arrives, the other one has
    // had at least as long to arrive and demonstrably did not.
    await publishSyncEvent(pub, mine, { type: 'sync.done', data: { repoId: 7 } });

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(seen.map((e) => e.data)).toEqual([{ repoId: 7 }]);
    await isolated.quit();
  });
});
