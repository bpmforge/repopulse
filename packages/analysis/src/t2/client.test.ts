import { describe, expect, it, vi } from 'vitest';
import { T2Client, T2_DEFAULTS, T2_MAX_TOKENS } from './client.js';
import type { CompleteOpts } from '../gateway/types.js';
import { containsCredentialMaterial } from '../config/hosts.js';

// Tier-2 wrapper (W6-01, ANALYSIS_TIERS.md §2, FR-ANALYSIS-2/NFR-8/C2).

const HOST = { baseUrl: 'http://lan:1234', modelSlot: 'qwen' };
const opts: CompleteOpts = {
  tier: 'T2',
  maxTokens: 100,
  expectJson: true,
  meta: { repoId: '1', prNumber: 2, dimension: 'code_health', checklistVersion: 'v1', initiator: 'test' },
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
const ok = () =>
  jsonResponse({ choices: [{ message: { content: '{"findings":[]}' } }], model: 'qwen', usage: { prompt_tokens: 10, completion_tokens: 4 } });

function client(fetchImpl: typeof fetch) {
  return new T2Client({ ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 2 }, { fetchImpl, sleep: () => Promise.resolve() });
}

describe('tier-2 wrapper', () => {
  it('sends 45000 max_tokens on the real call, whatever the caller asked for', async () => {
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens);
      return ok();
    }) as unknown as typeof fetch;

    await client(fetchImpl).complete('prompt', opts, HOST);
    // The caller passed 100. The cap is a property of the TIER (C2/NFR-8), not
    // a per-call preference — enforcing it here is the whole reason callers may
    // not reach LM Studio directly.
    expect(seen).toContain(T2_MAX_TOKENS);
    expect(seen).not.toContain(100);
  });

  it('warms up a cold host BEFORE the first real call', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return ok();
    }) as unknown as typeof fetch;

    await client(fetchImpl).complete('real prompt', opts, HOST);
    expect(bodies.length).toBe(2);
    expect(bodies[0]).toContain('ping');
    expect(bodies[1]).toContain('real prompt');
  });

  it('recovers from a model crash: warm-up, backoff, retry, succeed', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      if (body.includes('ping')) return ok();
      call += 1;
      // First real attempt crashes the way LM Studio actually crashes.
      if (call === 1) return new Response('model crashed', { status: 500 });
      return ok();
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).complete('review this', opts, HOST);
    expect(result.text).toContain('findings');
    expect(call).toBe(2);
  });

  it('does NOT retry an error that is not a crash', async () => {
    // A 400 is our bug, not the model's. Retrying it three times with backoff
    // wastes a minute and produces the same failure.
    let real = 0;
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body).includes('ping')) return ok();
      real += 1;
      return new Response('bad request: context too long', { status: 400 });
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).complete('x', opts, HOST)).rejects.toThrow(/400/);
    expect(real).toBe(1);
  });

  it('W25-19: a quick verdict asks for no reasoning; ordinary calls do not', async () => {
    const real: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!String(init?.body).includes('ping')) real.push(body);
      return ok();
    }) as unknown as typeof fetch;
    const c = client(fetchImpl);
    await c.complete('verdict', { ...opts, reasoning: 'none' }, HOST);
    await c.complete('review', opts, HOST);
    expect(real[0]?.reasoning_effort).toBe('none');
    expect(real[0]?.max_tokens).toBe(T2_MAX_TOKENS);
    expect(real[1]).not.toHaveProperty('reasoning_effort');
  });

  it('W25-19: a host that rejects reasoning_effort is asked again without it, and remembered', async () => {
    const real: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body).includes('ping')) return ok();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      real.push(body);
      if ('reasoning_effort' in body) {
        return new Response('Unrecognized request argument supplied: reasoning_effort', { status: 400 });
      }
      return ok();
    }) as unknown as typeof fetch;
    const c = client(fetchImpl);
    const r = await c.complete('verdict', { ...opts, reasoning: 'none' }, HOST);
    expect(r.text).toContain('findings');
    await c.complete('verdict 2', { ...opts, reasoning: 'none' }, HOST);
    expect(real.map((b) => 'reasoning_effort' in b)).toEqual([true, false, false]);
  });

  it('W25-19: AI_QUICK_VERDICTS=off (quickReasoning false) never sends the field', async () => {
    const real: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      if (!String(init?.body).includes('ping')) real.push(JSON.parse(String(init?.body)));
      return ok();
    }) as unknown as typeof fetch;
    const c = new T2Client(
      { ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 2, quickReasoning: false },
      { fetchImpl, sleep: () => Promise.resolve() },
    );
    await c.complete('verdict', { ...opts, reasoning: 'none' }, HOST);
    expect(real[0]).not.toHaveProperty('reasoning_effort');
  });

  it('reports cost as NULL for a LAN call, not zero', async () => {
    // 0 reads as "measured and free"; null says the concept does not apply.
    const result = await client((() => ok()) as unknown as typeof fetch).complete('x', opts, HOST);
    expect(result.costUsd).toBeNull();
  });

  it('returns no host when every host is at the concurrency cap', async () => {
    const c = new T2Client({ ...T2_DEFAULTS, hosts: [HOST], concurrencyCap: 1 }, {
      fetchImpl: (async () => {
        await new Promise((r) => setTimeout(r, 20));
        return ok();
      }) as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    const inflight = c.complete('a', opts, HOST);
    // Surfaced rather than queued internally: the scheduler parks the job, so a
    // saturated LAN never becomes an invisible in-process backlog.
    expect(c.pickHost()).toBeNull();
    await inflight;
    expect(c.pickHost()).not.toBeNull();
  });

  it('treats an unreachable host as a state, not an exception (NFR-7)', async () => {
    const c = client((() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    await expect(c.health(HOST)).resolves.toEqual({ ok: false });
  });
});

describe('SC-24 credential-free requests', () => {
  it('sends no authorization header and no secret in the body', async () => {
    // T-20/T-21: a LAN model needs no credential, and the diff payload must not
    // carry one either. Asserted on the ACTUAL outbound request rather than on
    // the header constant, so a future change inside chat() is caught too.
    let seenHeaders: Record<string, string> = {};
    let seenBody = '';
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      seenBody = String(init?.body);
      return ok();
    }) as unknown as typeof fetch;

    await client(fetchImpl).complete('review this diff', opts, HOST);

    expect(Object.keys(seenHeaders).map((k) => k.toLowerCase())).toEqual(['content-type']);
    expect(containsCredentialMaterial(seenBody)).toBe(false);
    expect(containsCredentialMaterial(JSON.stringify(seenHeaders))).toBe(false);
  });
});
