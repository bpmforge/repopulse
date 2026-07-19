import { describe, expect, it, vi } from 'vitest';
import { publishSyncEvent, syncEventsChannel } from './events.js';
import type { Redis } from 'ioredis';

describe('sync event publisher (API_DESIGN §3)', () => {
  it('channel is per-workspace', () => {
    expect(syncEventsChannel(42)).toBe('sync:events:42');
  });

  it('publishes the JSON event to the workspace channel', async () => {
    const publish = vi.fn(async () => 1);
    const redis = { publish } as unknown as Redis;
    await publishSyncEvent(redis, 7, { type: 'sync.progress', data: { repoId: 3, pct: 40 } });
    expect(publish).toHaveBeenCalledWith(
      'sync:events:7',
      JSON.stringify({ type: 'sync.progress', data: { repoId: 3, pct: 40 } }),
    );
  });
});
