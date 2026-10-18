import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateHostUrl } from '../config/hosts.js';
import { createAnalysisGateway } from './index.js';
import { createEgressAuditor, isLocalHost, type EgressAuditRow } from './egress-auditor.js';
import type { CompleteOpts } from './types.js';

// Data-egress auditing at the gateway boundary (W17-11).
//
// Every test here runs against a LOCAL fixture HTTP server. No paid endpoint,
// no network, no key — which is the point: an audit that can only be verified
// by spending money is an audit nobody verifies.

const META = {
  repoId: '42',
  prNumber: 1,
  dimension: 'security' as const,
  checklistVersion: 'v1',
  initiator: 'alice',
};

const OPTS: CompleteOpts = {
  tier: 'T2',
  maxTokens: 45000,
  expectJson: true,
  meta: META,
};

/** A fixture provider that answers, hangs, or fails on demand. */
function startProvider(mode: 'ok' | 'hang' | '500'): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      if (mode === 'hang') return; // never answers
      if (mode === '500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'provider exploded' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"findings":[]}' } }],
          model: 'fixture-model',
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        }),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

describe('isLocalHost — what counts as leaving the network', () => {
  it('treats loopback and private IPv4 as ON the network', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '127.0.0.1:1234',
      '127.0.0.2', // the whole 127/8 block is loopback
      '[::1]:1234', // URL.host form of IPv6 loopback
      '::1',
      '10.1.2.3',
      '192.168.13.179:1234',
      '172.16.0.9',
      '100.64.0.1', // CGNAT: private, as the host policy already treats it
    ]) {
      expect(isLocalHost(h), `${h} should be local`).toBe(true);
    }
  });

  it('treats a host NAME as OFF the network, even .local and .internal (IPs only, Brad 2026-10-18)', () => {
    // These were on-network until the audit and the host policy were made to
    // agree. A name resolves later, elsewhere; the policy already refuses one
    // without an explicit off-network decision, and so does the audit now.
    for (const h of [
      'lmstudio.local',
      'models.internal',
      'nas.lan',
      'studio',
      'host.containers.internal',
      'lmstudio.local:1234',
    ]) {
      expect(isLocalHost(h), `${h} should be remote`).toBe(false);
    }
  });

  it('does not treat link-local or the cloud metadata address as on-network', () => {
    for (const h of ['169.254.169.254', '169.254.1.1:80']) expect(isLocalHost(h)).toBe(false);
  });

  it('AGREES with the host policy: a host is on-network exactly when the policy accepts it without an off-network decision', () => {
    // The point of the change. Every row is a host the two could have disagreed on.
    const hosts = [
      'localhost',
      '127.0.0.1',
      '127.0.0.2',
      '::1',
      '[::1]',
      '10.0.0.1',
      '10.255.255.255',
      '172.15.0.1',
      '172.16.0.1',
      '172.31.255.1',
      '172.32.0.1',
      '192.168.0.1',
      '192.167.0.1',
      '100.63.0.1',
      '100.64.0.1',
      '100.127.0.1',
      '100.128.0.1',
      '169.254.169.254',
      '8.8.8.8',
      'example.com',
      'lmstudio.local',
      'models.internal',
      'nas.lan',
      '10.evil.com',
      '300.1.1.1',
    ];
    for (const h of hosts) {
      const url = h.includes(':') && !h.startsWith('[') ? `http://[${h}]:1234` : `http://${h}:1234`;
      let accepted = true;
      let hostPart = h;
      try {
        hostPart = new URL(url).host;
        validateHostUrl(url, { allowPublicHosts: false, allowLoopback: true });
      } catch {
        // Refused by the policy, or not a URL at all (300.1.1.1): not on-network.
        accepted = false;
      }
      expect(isLocalHost(hostPart), `${h}: policy ${accepted ? 'accepts' : 'refuses'}`).toBe(
        accepted,
      );
    }
  });

  it('treats everything else as OFF the network', () => {
    // Wrong in the safe direction: an unrecognised host is audited rather than
    // quietly exempted.
    for (const h of ['api.openai.com', 'api.anthropic.com', '8.8.8.8', 'example.com']) {
      expect(isLocalHost(h), `${h} should be remote`).toBe(false);
    }
  });

  it('does not mistake a public host that merely CONTAINS a private range', () => {
    expect(isLocalHost('10.evil.com')).toBe(false);
    expect(isLocalHost('192.168.evil.com')).toBe(false);
    expect(isLocalHost('notlocalhost.com')).toBe(false);
  });
});

describe('the auditor itself', () => {
  it('writes ATTEMPTED before dispatch and an outcome after, sharing an id', async () => {
    const rows: EgressAuditRow[] = [];
    const auditor = createEgressAuditor({ write: async (r) => void rows.push(r) });

    const attempt = await auditor.begin({
      workspaceId: 1,
      repoId: 2,
      tier: 2,
      modelId: 'm',
      destinationHost: 'api.example.com',
      bytesSent: 100,
      contentSha256: 'deadbeef',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('attempted');

    await attempt.settle('succeeded', { tokensSent: 5, tokensReceived: 6 });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.outcome).toBe('succeeded');
    // One attempt, two rows, one id.
    expect(rows[0]?.attemptId).toBe(rows[1]?.attemptId);
  });

  it('records UNKNOWN usage as null, never as a measured zero', async () => {
    const rows: EgressAuditRow[] = [];
    const auditor = createEgressAuditor({ write: async (r) => void rows.push(r) });
    const attempt = await auditor.begin({
      workspaceId: 1,
      repoId: 2,
      tier: 2,
      modelId: 'm',
      destinationHost: 'api.example.com',
      bytesSent: 100,
      contentSha256: 'x',
    });

    await attempt.settle('succeeded'); // provider reported no usage

    expect(rows[1]?.tokensSent).toBeNull();
    expect(rows[1]?.tokensReceived).toBeNull();
  });

  it('does not double-count when settle is called twice', async () => {
    // A persistence retry of the same attempt must not inflate the egress
    // total, which is the number this table exists to get right.
    const rows: EgressAuditRow[] = [];
    const auditor = createEgressAuditor({ write: async (r) => void rows.push(r) });
    const attempt = await auditor.begin({
      workspaceId: 1,
      repoId: 2,
      tier: 2,
      modelId: 'm',
      destinationHost: 'api.example.com',
      bytesSent: 1,
      contentSha256: 'x',
    });

    await attempt.settle('succeeded');
    await attempt.settle('failed', { error: 'late' });

    expect(rows.filter((r) => r.outcome !== 'attempted')).toHaveLength(1);
  });

  it('gives each separate attempt its own id — a retry IS a second egress', async () => {
    const rows: EgressAuditRow[] = [];
    const auditor = createEgressAuditor({ write: async (r) => void rows.push(r) });
    const base = {
      workspaceId: 1,
      repoId: 2,
      tier: 2,
      modelId: 'm',
      destinationHost: 'api.example.com',
      bytesSent: 1,
      contentSha256: 'x',
    };
    const a = await auditor.begin(base);
    const b = await auditor.begin(base);
    expect(a.attemptId).not.toBe(b.attemptId);
  });

  it('records a DENIED attempt with zero bytes', async () => {
    const rows: EgressAuditRow[] = [];
    const auditor = createEgressAuditor({ write: async (r) => void rows.push(r) });

    await auditor.denied(
      {
        workspaceId: 1,
        repoId: 2,
        tier: 3,
        modelId: 'tier3',
        destinationHost: 'anthropic',
        contentSha256: 'x',
      },
      'not opted in',
    );

    expect(rows[0]?.outcome).toBe('denied');
    expect(rows[0]?.bytesSent).toBe(0);
    expect(rows[0]?.error).toBe('not opted in');
  });

  it('propagates an audit-write failure instead of swallowing it', async () => {
    // The caller MUST NOT send when this rejects.
    const auditor = createEgressAuditor({
      write: async () => {
        throw new Error('audit table unavailable');
      },
    });

    await expect(
      auditor.begin({
        workspaceId: 1,
        repoId: 2,
        tier: 2,
        modelId: 'm',
        destinationHost: 'api.example.com',
        bytesSent: 1,
        contentSha256: 'x',
      }),
    ).rejects.toThrow(/audit table unavailable/);
  });
});

describe('the gateway, against a local fixture provider', () => {
  let provider: { url: string; close: () => void };
  let failing: { url: string; close: () => void };

  beforeAll(async () => {
    provider = await startProvider('ok');
    failing = await startProvider('500');
  });

  afterAll(() => {
    provider.close();
    failing.close();
  });

  function build(opts: {
    baseUrl: string;
    rows: EgressAuditRow[];
    writeFails?: boolean;
    resolveNull?: boolean;
    noAuditor?: boolean;
  }) {
    const auditor = createEgressAuditor({
      write: async (r) => {
        if (opts.writeFails) throw new Error('audit write refused');
        opts.rows.push(r);
      },
    });
    return createAnalysisGateway({
      hosts: [{ baseUrl: opts.baseUrl, modelSlot: 'fixture-model' }],
      ...(opts.noAuditor ? {} : { egressAuditor: auditor }),
      ...(opts.noAuditor
        ? {}
        : {
            resolveAuditIds: async () => (opts.resolveNull ? null : { workspaceId: 7, repoId: 42 }),
          }),
    });
  }

  it('does NOT audit a LAN host — that is not egress', async () => {
    const rows: EgressAuditRow[] = [];
    const gw = build({ baseUrl: provider.url, rows });

    await gw.complete('prompt', OPTS).catch(() => {
      /* the fixture's response shape is not the subject here */
    });

    // 127.0.0.1 is local, so nothing should be recorded at all.
    expect(rows).toHaveLength(0);
  });

  it('REFUSES to send to a remote host when it cannot audit', async () => {
    // Fail closed. This is the whole safety property.
    const rows: EgressAuditRow[] = [];
    const gw = build({ baseUrl: 'https://api.openai.com', rows, noAuditor: true });

    await expect(gw.complete('prompt', OPTS)).rejects.toThrow(/un-auditable egress/i);
    expect(rows).toHaveLength(0);
  });

  it('REFUSES to send when the audit write itself fails', async () => {
    const rows: EgressAuditRow[] = [];
    const gw = build({ baseUrl: 'https://api.openai.com', rows, writeFails: true });

    await expect(gw.complete('prompt', OPTS)).rejects.toThrow(/audit write refused/);
  });

  it('REFUSES to send when the egress cannot be attributed to a workspace', async () => {
    const rows: EgressAuditRow[] = [];
    const gw = build({ baseUrl: 'https://api.openai.com', rows, resolveNull: true });

    await expect(gw.complete('prompt', OPTS)).rejects.toThrow(/could not be attributed/i);
    expect(rows).toHaveLength(0);
  });

  it('records an ATTEMPT even when the remote request then fails', async () => {
    // The bytes left this network whether or not an answer came back — the case
    // a single after-the-fact row could never express.
    const rows: EgressAuditRow[] = [];
    // A remote-looking host that is actually the local failing fixture would be
    // treated as local, so use an unroutable public address with a short fail.
    const gw = createAnalysisGateway({
      hosts: [{ baseUrl: 'https://api.openai.example', modelSlot: 'm' }],
      egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
      resolveAuditIds: async () => ({ workspaceId: 7, repoId: 42 }),
    });

    await expect(gw.complete('prompt', OPTS)).rejects.toThrow();

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.outcome).toBe('attempted');
    expect(rows[0]?.destinationHost).toBe('api.openai.example');
    expect(rows[0]?.bytesSent).toBe(Buffer.byteLength('prompt', 'utf8'));
    const outcome = rows.find((r) => r.outcome !== 'attempted');
    expect(outcome?.outcome).toBe('failed');
    expect(outcome?.error).toBeTruthy();
    expect(outcome?.attemptId).toBe(rows[0]?.attemptId);
  });

  it('never stores the prompt itself — only its digest and byte count', async () => {
    const rows: EgressAuditRow[] = [];
    const gw = createAnalysisGateway({
      hosts: [{ baseUrl: 'https://api.openai.example', modelSlot: 'm' }],
      egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
      resolveAuditIds: async () => ({ workspaceId: 7, repoId: 42 }),
    });

    const secret = 'class Secret { const apiKey = "sk-do-not-store-me"; }';
    await gw.complete(secret, OPTS).catch(() => {});

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('sk-do-not-store-me');
    expect(serialized).not.toContain('class Secret');
    expect(rows[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a Tier-3 request that is NOT opted in is denied and recorded, not sent', async () => {
    const rows: EgressAuditRow[] = [];
    const t3 = vi.fn();
    const gw = createAnalysisGateway({
      hosts: [{ baseUrl: provider.url, modelSlot: 'm' }],
      egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
      resolveAuditIds: async () => ({ workspaceId: 7, repoId: 42 }),
      isT3OptedIn: async () => false,
      t3: t3 as never,
    });

    await expect(gw.complete('prompt', { ...OPTS, tier: 'T3' })).rejects.toThrow();

    // Never reached the transport.
    expect(t3).not.toHaveBeenCalled();
    expect(rows[0]?.outcome).toBe('denied');
    expect(rows[0]?.bytesSent).toBe(0);
  });
});

describe('a model reached by a host name is audited like any off-network call (IPs only)', () => {
  const opts: CompleteOpts = {
    tier: 'T2',
    maxTokens: 100,
    expectJson: true,
    meta: {
      repoId: '1',
      prNumber: 1,
      dimension: 'security',
      checklistVersion: 'v1',
      initiator: 't',
    },
  };
  const ok = () =>
    new Response(
      JSON.stringify({
        model: 'm',
        choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );

  it('writes the attempt and the outcome for lmstudio.local, which used to be exempt', async () => {
    const rows: EgressAuditRow[] = [];
    const gw = createAnalysisGateway({
      hosts: [{ baseUrl: 'http://lmstudio.local:1234/v1', modelSlot: 'm' }],
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
      sleep: async () => {},
      egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
      resolveAuditIds: async () => ({ workspaceId: 1, repoId: 1 }),
    });
    await gw.complete('p', opts);
    expect(rows.map((r) => r.outcome)).toEqual(['attempted', 'succeeded']);
    expect(rows[0]?.destinationHost).toBe('lmstudio.local:1234');
  });

  it('refuses to send to it when the deployment cannot record the egress', async () => {
    const gw = createAnalysisGateway({
      hosts: [{ baseUrl: 'http://lmstudio.local:1234/v1', modelSlot: 'm' }],
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
    });
    await expect(gw.complete('p', opts)).rejects.toThrow(/un-auditable egress/);
  });

  it('the same machine by IP address is still not egress and writes no row', async () => {
    const rows: EgressAuditRow[] = [];
    const gw = createAnalysisGateway({
      hosts: [{ baseUrl: 'http://192.168.1.50:1234/v1', modelSlot: 'm' }],
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
      sleep: async () => {},
      egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
      resolveAuditIds: async () => ({ workspaceId: 1, repoId: 1 }),
    });
    await gw.complete('p', opts);
    expect(rows).toEqual([]);
  });
});
