import 'dotenv/config';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
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
});
