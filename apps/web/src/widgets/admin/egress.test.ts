import { describe, expect, it } from 'vitest';
import { summarizeRole, WHAT_IS_SENT, type EgressLink, type EgressProvider } from './egress.js';

// W19-07. The screen must say plainly what leaves the network, from what the
// server reports - not from names, and not optimistically.

const lan: EgressProvider = {
  id: 1,
  name: 'LM Studio',
  enabled: true,
  host: '10.0.0.5:1234',
  leaves_network: false,
};
const cloud: EgressProvider = {
  id: 2,
  name: 'Gemini',
  enabled: true,
  host: 'generativelanguage.googleapis.com',
  leaves_network: true,
};
const link = (p: EgressProvider): EgressLink => ({
  provider_id: p.id,
  provider_name: p.name,
  host: p.host,
  leaves_network: p.leaves_network,
});

describe('summarizeRole', () => {
  it('says a local chain stays on the network', () => {
    const s = summarizeRole({ chain: [link(lan)], providers: [lan, cloud], localOnly: false });
    expect(s.tone).toBe('stays');
    expect(s.text).toBe('Stays on your network. Uses LM Studio.');
  });

  it('names the host, what is sent, and the audit when a hosted connection is first', () => {
    const s = summarizeRole({ chain: [link(cloud)], providers: [lan, cloud], localOnly: false });
    expect(s.tone).toBe('leaves');
    expect(s.text).toContain('generativelanguage.googleapis.com');
    expect(s.text).toContain(WHAT_IS_SENT);
    expect(s.text).toMatch(/recorded in the egress audit/);
  });

  it('does not call a role local when only its first choice is: a hosted fallback can still send it away', () => {
    const s = summarizeRole({
      chain: [link(lan), link(cloud)],
      providers: [lan, cloud],
      localOnly: false,
    });
    expect(s.tone).toBe('leaves');
    expect(s.text).toMatch(
      /Normally stays on your network \(LM Studio\), but the fallback can send it away/,
    );
    expect(s.text).toContain('generativelanguage.googleapis.com');
  });

  it('a local fallback behind a hosted first choice is still described as leaving, with the fallback shown', () => {
    const s = summarizeRole({
      chain: [link(cloud), link(lan)],
      providers: [lan, cloud],
      localOnly: false,
    });
    expect(s.tone).toBe('leaves');
    expect(s.text).toMatch(/LM Studio \(stays on your network\) is tried/);
  });

  it('describes the shared pool: local only, mixed, and empty', () => {
    expect(summarizeRole({ chain: [], providers: [lan], localOnly: false })).toMatchObject({
      tone: 'stays',
    });
    const mixed = summarizeRole({ chain: [], providers: [lan, cloud], localOnly: false });
    expect(mixed.tone).toBe('leaves');
    expect(mixed.text).toMatch(/May leave your network: the shared pool includes Gemini/);
    expect(summarizeRole({ chain: [], providers: [], localOnly: false }).tone).toBe('unavailable');
  });

  it('under local-only a mixed pool uses only the local connections, and an all-hosted pool is unavailable', () => {
    expect(summarizeRole({ chain: [], providers: [lan, cloud], localOnly: true })).toMatchObject({
      tone: 'stays',
      text: 'Stays on your network. Uses LM Studio.',
    });
    const none = summarizeRole({ chain: [], providers: [cloud], localOnly: true });
    expect(none.tone).toBe('unavailable');
    expect(none.text).toMatch(/No connection on your network/);
  });

  it('ignores disabled connections in the pool', () => {
    expect(
      summarizeRole({ chain: [], providers: [{ ...cloud, enabled: false }, lan], localOnly: false })
        .tone,
    ).toBe('stays');
  });

  it('never trusts a name: a hosted connection called "Local" still leaves', () => {
    const liar: EgressProvider = { ...cloud, name: 'Local (on-prem)' };
    expect(summarizeRole({ chain: [link(liar)], providers: [liar], localOnly: false }).tone).toBe(
      'leaves',
    );
  });

  it('treats an endpoint it cannot classify as leaving, never as staying', () => {
    const unknown: EgressProvider = {
      id: 3,
      name: 'Odd',
      enabled: true,
      host: null,
      leaves_network: null,
    };
    const s = summarizeRole({ chain: [link(unknown)], providers: [unknown], localOnly: false });
    expect(s.tone).toBe('leaves');
    expect(s.text).toContain('an endpoint we could not read');
  });

  // W20-06 (UX_TODO AI-06): a gateway on a LAN IP is on the network, but may
  // forward what it receives; the host alone cannot say "stays home".
  it('never calls a gateway "stays": it stays on your network only if the gateway does', () => {
    const gw: EgressProvider = { ...lan, id: 4, name: 'LiteLLM', host: '10.0.0.7:4000' };
    const s = summarizeRole({
      chain: [link(gw)],
      providers: [gw],
      localOnly: false,
      gatewayIds: new Set([4]),
    });
    expect(s.tone).toBe('gateway');
    expect(s.text).toMatch(
      /LiteLLM is a gateway: your code stays on your network only if the gateway does not forward it/,
    );
    expect(s.text).not.toMatch(/^Stays on your network/);
    // Without the gateway mark, the same LAN host still reads as staying.
    expect(summarizeRole({ chain: [link(gw)], providers: [gw], localOnly: false }).tone).toBe(
      'stays',
    );
  });

  // W20-06 (UX_TODO AI-58): under Local only an off-network link is blocked, so
  // the review must not say "Leaves your network" beneath "Local only is on".
  it('under Local only marks off-network chain links as blocked, never as leaving', () => {
    const first = summarizeRole({ chain: [link(cloud)], providers: [lan, cloud], localOnly: true });
    expect(first.tone).toBe('unavailable');
    expect(first.text).toMatch(
      /^Blocked by Local only: Gemini \(generativelanguage.googleapis.com\)/,
    );
    expect(first.text).not.toMatch(/Leaves your network/);

    const fallback = summarizeRole({
      chain: [link(lan), link(cloud)],
      providers: [lan, cloud],
      localOnly: true,
    });
    expect(fallback.tone).toBe('stays');
    expect(fallback.text).toMatch(/Uses LM Studio\. Local only blocks Gemini/);
    expect(fallback.text).toMatch(/refuses instead of falling back/);
  });
});
