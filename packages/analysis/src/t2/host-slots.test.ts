import { describe, expect, it } from 'vitest';
import { T2Client, T2_DEFAULTS } from './client.js';
import { HostBusyError, HostSlots } from './host-slots.js';

const HOST = { baseUrl: 'http://lan-host:1234', modelSlot: 'm' };

/** A promise plus the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

// 2026-10-27 walkthrough: four scans, each on its own T2Client, sent work to
// one LM Studio at once because the cap was counted per client.
describe('per-host slots shared across clients', () => {
  it("a second client waits for the first one's call on the same host", async () => {
    const slots = new HostSlots();
    const config = { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1, queueTimeoutMs: 5_000 };
    const a = new T2Client(config, { slots });
    const b = new T2Client(config, { slots });
    const order: string[] = [];
    const first = gate();

    const callA = a.track(HOST, async () => {
      order.push('a start');
      await first.wait;
      order.push('a end');
    });
    const callB = b.track(HOST, async () => {
      order.push('b start');
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['a start']);
    first.open();
    await Promise.all([callA, callB]);
    expect(order).toEqual(['a start', 'a end', 'b start']);
    expect(slots.active(HOST.baseUrl)).toBe(0);
  });

  it('gives up after the queue timeout, by name, without calling the host', async () => {
    const slots = new HostSlots();
    const release = await slots.acquire(HOST.baseUrl, 1, 1_000);
    const b = new T2Client(
      { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1, queueTimeoutMs: 30 },
      { slots },
    );
    let called = false;
    await expect(
      b.track(HOST, async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(HostBusyError);
    expect(called).toBe(false);
    release();
    expect(slots.active(HOST.baseUrl)).toBe(0);
  });

  it('keeps separate hosts independent and honours a cap above one', async () => {
    const slots = new HostSlots();
    const r1 = await slots.acquire('h1', 2, 100);
    const r2 = await slots.acquire('h1', 2, 100);
    const other = await slots.acquire('h2', 1, 100);
    await expect(slots.acquire('h1', 2, 20)).rejects.toBeInstanceOf(HostBusyError);
    r1();
    r1(); // a second release of the same slot is a no-op
    const r3 = await slots.acquire('h1', 2, 100);
    expect(slots.active('h1')).toBe(2);
    for (const r of [r2, r3, other]) r();
    expect(slots.active('h1')).toBe(0);
  });

  // 2026-10-29 outline run: anti-slop failed twice while the AI judge, which
  // takes minutes a verdict, held LM Studio's only slot.
  it('serves a scan waiting for the host before a background (judge) call queued earlier', async () => {
    const slots = new HostSlots();
    const scanClient = new T2Client(
      { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1, queueTimeoutMs: 5_000 },
      { slots },
    );
    const judgeClient = new T2Client(
      { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1, queueTimeoutMs: 5_000 },
      { slots, background: true },
    );
    const order: string[] = [];
    const first = gate();
    const judge1 = judgeClient.track(HOST, async () => {
      order.push('judge 1');
      await first.wait;
    });
    await new Promise((r) => setTimeout(r, 5));
    const judge2 = judgeClient.track(HOST, async () => {
      order.push('judge 2');
    });
    await new Promise((r) => setTimeout(r, 5));
    const scan = scanClient.track(HOST, async () => {
      order.push('scan');
    });
    await new Promise((r) => setTimeout(r, 5));
    first.open();
    await Promise.all([judge1, judge2, scan]);
    expect(order).toEqual(['judge 1', 'scan', 'judge 2']);
  });

  it('keeps first-come order among calls of the same kind', async () => {
    const slots = new HostSlots();
    const hold = await slots.acquire('h', 1, 1_000);
    const order: string[] = [];
    const wait = (name: string, background: boolean) =>
      slots.acquire('h', 1, 1_000, { background }).then((r) => {
        order.push(name);
        r();
      });
    const all = [wait('bg1', true), wait('s1', false), wait('bg2', true), wait('s2', false)];
    hold();
    await Promise.all(all);
    expect(order).toEqual(['s1', 's2', 'bg1', 'bg2']);
  });
});

// W25-06: cancelling an AI pass must stop its model call and free the slot.
describe('a cancelled call leaves the queue and frees the host (W25-06)', () => {
  it('a waiter whose signal aborts leaves the queue; the next waiter gets the slot', async () => {
    const slots = new HostSlots();
    const release = await slots.acquire('h', 1, 5_000);
    const cancel = new AbortController();
    const cancelled = slots.acquire('h', 1, 5_000, { signal: cancel.signal });
    const next = slots.acquire('h', 1, 5_000);
    cancel.abort(new Error('pass cancelled'));
    await expect(cancelled).rejects.toThrow('pass cancelled');
    release();
    const releaseNext = await next;
    expect(slots.active('h')).toBe(1);
    releaseNext();
    expect(slots.active('h')).toBe(0);
  });

  it('an in-flight completion is aborted at the HTTP request and its slot freed', async () => {
    const slots = new HostSlots();
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.max_tokens === 8) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      seen = init?.signal ?? undefined;
      // A model that would answer in 20 minutes, unless the request is aborted.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const client = new T2Client(
      { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1, queueTimeoutMs: 5_000 },
      { slots, fetchImpl, sleep: async () => {} },
    );
    const cancel = new AbortController();
    const call = client.complete(
      'p',
      {
        tier: 'T2',
        maxTokens: 1,
        expectJson: true,
        meta: {
          repoId: '1',
          prNumber: 0,
          dimension: 'security',
          checklistVersion: 'v',
          initiator: 't',
        },
        signal: cancel.signal,
      },
      HOST,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(slots.active(HOST.baseUrl)).toBe(1);
    cancel.abort(new Error('pass cancelled'));
    await expect(call).rejects.toThrow('pass cancelled');
    expect(seen?.aborted).toBe(true);
    // No crash-retry after a cancel, and the slot is free at once.
    expect(slots.active(HOST.baseUrl)).toBe(0);
  });
});

// W25-13: a pass on a one-slot local model looked stuck; the screen could not
// tell "waiting behind other analysis" from "the model is answering".
describe('onSent (W25-13)', () => {
  const meta = {
    repoId: '1',
    prNumber: 0,
    dimension: 'security' as const,
    checklistVersion: 'v',
    initiator: 't',
  };
  const answer = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      headers: { 'content-type': 'application/json' },
    });

  it('is called once the slot is acquired, before the request goes out', async () => {
    const slots = new HostSlots();
    const config = { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1, queueTimeoutMs: 5_000 };
    const order: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens: number };
      if (body.max_tokens !== 8) order.push('request');
      return answer();
    }) as unknown as typeof fetch;
    const other = new T2Client(config, { slots });
    const client = new T2Client(config, { slots, fetchImpl, sleep: async () => {} });
    const busy = gate();
    const holder = other.track(HOST, () => busy.wait);
    await new Promise((r) => setTimeout(r, 5));

    const call = client.complete(
      'p',
      {
        tier: 'T2',
        maxTokens: 1,
        expectJson: true,
        meta,
        onSent: () => order.push('sent'),
      },
      HOST,
    );
    await new Promise((r) => setTimeout(r, 10));
    // Still waiting for the slot: nothing is reported as sent.
    expect(order).toEqual([]);
    busy.open();
    await holder;
    await call;
    expect(order).toEqual(['sent', 'request']);
  });

  it('is not called for a call aborted while it waited in the queue', async () => {
    const slots = new HostSlots();
    const config = { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1, queueTimeoutMs: 5_000 };
    const other = new T2Client(config, { slots });
    const client = new T2Client(config, {
      slots,
      fetchImpl: (async () => answer()) as unknown as typeof fetch,
      sleep: async () => {},
    });
    const busy = gate();
    const holder = other.track(HOST, () => busy.wait);
    await new Promise((r) => setTimeout(r, 5));
    const cancel = new AbortController();
    let sent = 0;
    const call = client.complete(
      'p',
      {
        tier: 'T2',
        maxTokens: 1,
        expectJson: true,
        meta,
        signal: cancel.signal,
        onSent: () => (sent += 1),
      },
      HOST,
    );
    cancel.abort(new Error('pass cancelled'));
    await expect(call).rejects.toThrow('pass cancelled');
    busy.open();
    await holder;
    expect(sent).toBe(0);
  });

  it('a throwing onSent never fails the call', async () => {
    const client = new T2Client(
      { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1, queueTimeoutMs: 5_000 },
      {
        slots: new HostSlots(),
        fetchImpl: (async () => answer()) as unknown as typeof fetch,
        sleep: async () => {},
      },
    );
    const r = await client.complete(
      'p',
      {
        tier: 'T2',
        maxTokens: 1,
        expectJson: true,
        meta,
        onSent: () => {
          throw new Error('db down');
        },
      },
      HOST,
    );
    expect(r.text).toBe('ok');
  });
});
