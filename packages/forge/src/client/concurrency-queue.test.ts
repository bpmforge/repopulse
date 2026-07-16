import { describe, expect, it } from 'vitest';
import { ConcurrencyQueue } from './concurrency-queue.js';

describe('ConcurrencyQueue', () => {
  it('admits immediately while under the concurrency cap', async () => {
    const queue = new ConcurrencyQueue(2);
    const releaseA = await queue.acquire('backfill');
    const releaseB = await queue.acquire('user');
    expect(queue.queueDepth).toEqual({ webhook: 0, user: 0, backfill: 0, reconcile: 0 });
    releaseA();
    releaseB();
  });

  it('queues beyond the cap and drains highest-priority lane first', async () => {
    const queue = new ConcurrencyQueue(1);
    const releaseFirst = await queue.acquire('backfill');

    const order: string[] = [];
    const reconcilePromise = queue.acquire('reconcile').then((release) => {
      order.push('reconcile');
      return release;
    });
    const webhookPromise = queue.acquire('webhook').then((release) => {
      order.push('webhook');
      return release;
    });
    const userPromise = queue.acquire('user').then((release) => {
      order.push('user');
      return release;
    });

    // all three are queued behind the single in-flight slot
    expect(queue.queueDepth).toEqual({ webhook: 1, user: 1, backfill: 0, reconcile: 1 });

    releaseFirst(); // frees one slot -> highest priority queued lane (webhook) goes next
    const releaseWebhook = await webhookPromise;
    expect(order).toEqual(['webhook']);

    releaseWebhook();
    const releaseUser = await userPromise;
    expect(order).toEqual(['webhook', 'user']);

    releaseUser();
    await reconcilePromise;
    expect(order).toEqual(['webhook', 'user', 'reconcile']);
  });
});
