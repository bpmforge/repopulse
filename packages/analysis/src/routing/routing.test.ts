import { describe, expect, it, vi } from 'vitest';
import { createEgressAuditor } from '../gateway/egress-auditor.js';
import { createAnalysisGateway } from '../gateway/index.js';
import type { CompleteOpts } from '../gateway/types.js';
import type { T2Host } from '../t2/client.js';
import {
  LLM_ROLES,
  LocalOnlyViolationError,
  contextWindowForRole,
  defaultPool,
  localOnlyViolations,
  roleForDimension,
  type RouteLink,
  type RoutingPolicy,
} from './index.js';

const meta = {
  repoId: '42',
  prNumber: 7,
  dimension: 'security' as const,
  checklistVersion: 'v1',
  initiator: 'test',
};
const opts: CompleteOpts = { tier: 'T2', maxTokens: 1000, expectJson: true, meta };
const t3Opts: CompleteOpts = { ...opts, tier: 'T3' };

const lan = (n: number): T2Host => ({
  baseUrl: `http://10.0.0.${n}:1234/v1`,
  modelSlot: `lan-${n}`,
  providerId: n,
  name: `LAN ${n}`,
});
const cloud: T2Host = {
  baseUrl: 'https://api.example-llm.com/v1',
  modelSlot: 'cloud-m',
  providerId: 9,
  name: 'Hosted',
};
const link = (host: T2Host): RouteLink => ({ host, providerName: host.name ?? host.baseUrl });

const ok = (model: string, content = '{"findings":[]}') =>
  new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

/** fetch keyed by host: `status` for a provider failure, `bad` for an empty answer. */
function fakeFetch(behaviour: Record<string, 'ok' | number | 'bad'>) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // Warm-up pings (max_tokens 8) are answered like any other call.
    calls.push(`${host}${body.max_tokens === 8 ? ' (warm-up)' : ''}`);
    const how = behaviour[host] ?? 'ok';
    if (how === 'ok') return ok(body.model);
    if (how === 'bad') {
      // A reasoning model that spent its whole budget thinking (W16-38).
      return new Response(
        JSON.stringify({
          model: body.model,
          choices: [
            { message: { content: '', reasoning_content: 'hmm…' }, finish_reason: 'length' },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('unavailable', { status: how });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const gatewayFor = (
  hosts: T2Host[],
  chains: RoutingPolicy,
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof createAnalysisGateway>[0]> = {},
) =>
  createAnalysisGateway({
    hosts,
    routing: chains,
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });

describe('roles', () => {
  it('uses the names in ATTEST_EXPERTS.md so the specialist roster plugs in unrenamed', () => {
    expect([...LLM_ROLES]).toEqual([
      'security',
      'performance',
      'code_health',
      'best_practices',
      'ai_slop',
      'test_coverage',
      'triage',
      'patch',
    ]);
  });
  it('maps an analysis dimension to its role, and knows when it cannot', () => {
    expect(roleForDimension('code_health')).toBe('code_health');
    expect(roleForDimension('knowledge')).toBeNull();
  });
});

describe('a chain falls back on PROVIDER errors only (W19-02)', () => {
  it('moves to the next link when the first provider is down, and records both', async () => {
    const f = fakeFetch({ '10.0.0.1:1234': 503 });
    const onRouted = vi.fn();
    const gw = gatewayFor(
      [lan(1), lan(2)],
      { localOnly: false, chains: { security: [link(lan(1)), link(lan(2))] } },
      f.impl,
      { onRouted },
    );
    const r = await gw.complete('p', opts);
    expect(r.model).toBe('lan-2');
    expect(r.route).toMatchObject({
      role: 'security',
      providerName: 'LAN 2',
      model: 'lan-2',
      linkIndex: 1,
    });
    expect(r.route?.failedLinks[0]).toMatchObject({ providerName: 'LAN 1' });
    expect(r.route?.failedLinks[0]?.error).toMatch(/503/);
    expect(onRouted).toHaveBeenCalledWith(r.route);
  });

  it('does NOT fall back on a bad answer — the second model is never asked', async () => {
    const f = fakeFetch({ '10.0.0.1:1234': 'bad' });
    const gw = gatewayFor(
      [lan(1), lan(2)],
      { localOnly: false, chains: { security: [link(lan(1)), link(lan(2))] } },
      f.impl,
    );
    await expect(gw.complete('p', opts)).rejects.toThrow(/no answer/i);
    expect(f.calls.some((c) => c.startsWith('10.0.0.2'))).toBe(false);
  });

  it('says which role failed and why when every link is down', async () => {
    const f = fakeFetch({ '10.0.0.1:1234': 503, '10.0.0.2:1234': 429 });
    const gw = gatewayFor(
      [lan(1), lan(2)],
      { localOnly: false, chains: { security: [link(lan(1)), link(lan(2))] } },
      f.impl,
    );
    await expect(gw.complete('p', opts)).rejects.toThrow(
      /role "security".*LAN 1.*503.*LAN 2.*429/s,
    );
  });

  it('routes by role: another role with no chain uses the shared pool as before', async () => {
    const f = fakeFetch({});
    const gw = gatewayFor(
      [lan(1), lan(2)],
      { localOnly: false, chains: { security: [link(lan(2))] } },
      f.impl,
    );
    const r = await gw.complete('p', { ...opts, meta: { ...meta, dimension: 'performance' } });
    expect(r.route?.role).toBe('performance');
    expect(r.model).toBe('lan-1');
  });

  it('an explicit meta.role wins over the dimension', async () => {
    const f = fakeFetch({});
    const gw = gatewayFor(
      [lan(1), lan(2)],
      { localOnly: false, chains: { triage: [link(lan(2))], security: [link(lan(1))] } },
      f.impl,
    );
    const r = await gw.complete('p', { ...opts, meta: { ...meta, role: 'triage' } });
    expect(r.model).toBe('lan-2');
  });
});

describe('a routed role with no usable connection (W19-02)', () => {
  it('refuses by name instead of quietly using the shared pool and a model nobody chose', async () => {
    const f = fakeFetch({});
    const gw = gatewayFor([lan(1)], { localOnly: false, chains: { security: [] } }, f.impl);
    await expect(gw.complete('p', opts)).rejects.toThrow(
      /Role "security" is routed.*none of them is usable/s,
    );
    expect(f.impl).not.toHaveBeenCalled();
  });
});

describe('local-only (W19-02)', () => {
  it('names the role and the connection that would leave the network', () => {
    const msgs = localOnlyViolations({
      localOnly: true,
      chains: { patch: [link(lan(1)), link(cloud)] },
    });
    expect(msgs).toEqual([
      'Local-only is on: role "patch" would send to connection "Hosted", which is outside your network.',
    ]);
    expect(localOnlyViolations({ localOnly: false, chains: { patch: [link(cloud)] } })).toEqual([]);
  });

  it('refuses at call time too, before anything is sent', async () => {
    const f = fakeFetch({});
    const gw = gatewayFor(
      [cloud],
      { localOnly: true, chains: { security: [link(cloud)] } },
      f.impl,
    );
    await expect(gw.complete('p', opts)).rejects.toThrow(LocalOnlyViolationError);
    expect(f.impl).not.toHaveBeenCalled();
  });

  it('keeps non-local providers out of the shared pool for an unrouted role', async () => {
    expect(defaultPool([lan(1), cloud], true)).toEqual([lan(1)]);
    expect(defaultPool([lan(1), cloud], false)).toEqual([lan(1), cloud]);
    const f = fakeFetch({});
    const gw = gatewayFor([cloud, lan(1)], { localOnly: true, chains: {} }, f.impl);
    expect((await gw.complete('p', opts)).model).toBe('lan-1');
  });

  it('refuses Tier-3 and records the denial; the Tier-3 transport is never called', async () => {
    const t3 = vi.fn();
    const rows: { outcome?: string; error?: string | null }[] = [];
    const gw = gatewayFor([lan(1)], { localOnly: true, chains: {} }, fakeFetch({}).impl, {
      isT3OptedIn: async () => true,
      t3,
      egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
      resolveAuditIds: async () => ({ workspaceId: 1, repoId: 1 }),
    });
    await expect(gw.complete('p', t3Opts)).rejects.toThrow(/Local-only is on/);
    expect(t3).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('denied');
  });
});

describe('Tier-3 and the egress audit behave as before when local-only is off (W19-02)', () => {
  const t3Result = {
    text: 'ok',
    model: 'claude',
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0.01,
    durationMs: 5,
  };

  it('an opted-in Tier-3 call is still audited (attempt + outcome), routing present', async () => {
    const rows: unknown[] = [];
    const gw = gatewayFor(
      [lan(1)],
      { localOnly: false, chains: { security: [link(lan(1))] } },
      fakeFetch({}).impl,
      {
        isT3OptedIn: async () => true,
        t3: vi.fn(async () => t3Result),
        egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
        resolveAuditIds: async () => ({ workspaceId: 1, repoId: 1 }),
      },
    );
    await expect(gw.complete('p', t3Opts)).resolves.toMatchObject({ costUsd: 0.01 });
    expect(rows).toHaveLength(2);
  });

  it('a Tier-3 call without the opt-in is still refused, not downgraded', async () => {
    const t3 = vi.fn();
    const gw = gatewayFor([lan(1)], { localOnly: false, chains: {} }, fakeFetch({}).impl, {
      isT3OptedIn: async () => false,
      t3,
    });
    await expect(gw.complete('p', t3Opts)).rejects.toThrow(/must never be implicit/);
    expect(t3).not.toHaveBeenCalled();
  });

  it('every attempt at a NON-local link is audited, including the one that failed', async () => {
    const rows: { outcome?: string; destinationHost?: string }[] = [];
    const f = fakeFetch({ 'api.example-llm.com': 503 });
    const gw = gatewayFor(
      [cloud, lan(2)],
      { localOnly: false, chains: { security: [link(cloud), link(lan(2))] } },
      f.impl,
      {
        egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
        resolveAuditIds: async () => ({ workspaceId: 1, repoId: 1 }),
      },
    );
    const r = await gw.complete('p', opts);
    expect(r.model).toBe('lan-2');
    // The bytes went to the cloud host whether or not it answered: attempt + failed.
    expect(rows.map((x) => x.outcome)).toEqual(['attempted', 'failed']);
    expect(rows[0]?.destinationHost).toBe('api.example-llm.com');
  });
});

describe('contextWindowForRole (W19-03)', () => {
  const w = (h: T2Host, contextWindow?: number): T2Host => ({ ...h, contextWindow });
  it('takes the smallest known window along the chain, because any link can serve a call', () => {
    const policy = {
      localOnly: false,
      chains: { security: [link(w(lan(1), 262144)), link(w(lan(2), 16384)), link(lan(3))] },
    };
    expect(contextWindowForRole(policy, 'security', [])).toBe(16384);
  });
  it('is null when nothing is known, so callers keep the default budget', () => {
    expect(contextWindowForRole({ localOnly: false, chains: {} }, 'patch', [lan(1)])).toBeNull();
  });
  it('uses the shared pool for an unrouted role, minus non-local hosts under local-only', () => {
    const pool = [w(cloud, 4096), w(lan(1), 32768)];
    expect(contextWindowForRole({ localOnly: false, chains: {} }, 'triage', pool)).toBe(4096);
    expect(contextWindowForRole({ localOnly: true, chains: {} }, 'triage', pool)).toBe(32768);
  });
});

describe('host names are not on the network (IPs only, 2026-10-18)', () => {
  const nas: T2Host = {
    baseUrl: 'http://nas.local:1234/v1',
    modelSlot: 'm',
    providerId: 4,
    name: 'NAS',
  };

  it('a *.local or *.internal connection now leaves the network for local-only', () => {
    for (const baseUrl of ['http://nas.local:1234/v1', 'http://models.internal:1234/v1']) {
      expect(
        localOnlyViolations({ localOnly: true, chains: { patch: [link({ ...nas, baseUrl })] } }),
      ).toHaveLength(1);
    }
  });

  it('the refusal explains why, because the machine may be sitting next to the admin', () => {
    const [msg] = localOnlyViolations({ localOnly: true, chains: { patch: [link(nas)] } });
    expect(msg).toBe(
      'Local-only is on: role "patch" would send to connection "NAS", which is outside your network. It is reached by the host name nas.local:1234, and only IP addresses count as on your network - use the machine\'s IP address.',
    );
  });

  it('an ordinary public name gets no such hint - it never counted as home', () => {
    const [msg] = localOnlyViolations({ localOnly: true, chains: { patch: [link(cloud)] } });
    expect(msg).toBe(
      'Local-only is on: role "patch" would send to connection "Hosted", which is outside your network.',
    );
  });

  it('the shared pool under local-only drops it, and the same machine by IP stays', () => {
    expect(
      defaultPool(
        [nas, { ...nas, baseUrl: 'http://192.168.1.50:1234/v1', name: 'NAS by IP' }],
        true,
      ).map((h) => h.name),
    ).toEqual(['NAS by IP']);
  });
});
