import { describe, expect, it, vi } from 'vitest';
import { createEgressAuditor } from './egress-auditor.js';
import { createAnalysisGateway, HostUnavailableError } from './index.js';
import { TierNotPermittedError, type CompleteOpts } from './types.js';
import { shouldEnqueue, reviewJobId, analysisStatus } from '../scheduling/index.js';

const meta = { repoId: '42', prNumber: 7, dimension: 'security' as const, checklistVersion: 'v1', initiator: 'test' };
const t3Opts: CompleteOpts = { tier: 'T3', maxTokens: 1000, expectJson: true, meta };
const t2Opts: CompleteOpts = { ...t3Opts, tier: 'T2' };

describe('tier dispatch (FR-ANALYSIS-1)', () => {
  it('REJECTS Tier-3 without a per-repo opt-in — never downgrades to Tier-2', async () => {
    const t3 = vi.fn();
    const gateway = createAnalysisGateway({ hosts: [], isT3OptedIn: async () => false, t3 });
    await expect(gateway.complete('p', t3Opts)).rejects.toThrow(TierNotPermittedError);
    // The silent downgrade is the dangerous outcome: an operator who asked for
    // a deep review would get a shallow one with nothing saying so.
    expect(t3).not.toHaveBeenCalled();
  });

  it('explains WHY it refused, so nobody deletes the check as noise', async () => {
    const gateway = createAnalysisGateway({ hosts: [], isT3OptedIn: async () => false });
    await expect(gateway.complete('p', t3Opts)).rejects.toThrow(/must never be implicit/);
  });

  it('allows Tier-3 once the repo has opted in AND the egress can be audited', async () => {
    // W17-11 changed what this test is about. Opt-in alone is no longer enough:
    // Tier-3 leaves the customer's network, so it now also requires that the
    // call can be recorded. The auditor here is what a real deployment supplies.
    const t3 = vi.fn(async () => ({ text: 'ok', model: 'claude', tokensIn: 1, tokensOut: 1, costUsd: 0.01, durationMs: 5 }));
    const rows: unknown[] = [];
    const gateway = createAnalysisGateway({
      hosts: [],
      isT3OptedIn: async () => true,
      t3,
      egressAuditor: createEgressAuditor({ write: async (r) => void rows.push(r) }),
      resolveAuditIds: async () => ({ workspaceId: 1, repoId: 1 }),
    });
    await expect(gateway.complete('p', t3Opts)).resolves.toMatchObject({ costUsd: 0.01 });
    // And it really was audited — attempt + outcome.
    expect(rows).toHaveLength(2);
  });

  it('REFUSES an opted-in Tier-3 call it cannot audit (W17-11)', async () => {
    // Fail closed. Before W17-11 this call succeeded with no record at all,
    // which is exactly the hole NFR-9 exists to prevent.
    const t3 = vi.fn(async () => ({ text: 'ok', model: 'claude', tokensIn: 1, tokensOut: 1, costUsd: 0.01, durationMs: 5 }));
    const gateway = createAnalysisGateway({ hosts: [], isT3OptedIn: async () => true, t3 });

    await expect(gateway.complete('p', t3Opts)).rejects.toThrow(/un-auditable egress/i);
    expect(t3).not.toHaveBeenCalled();
  });

  it('treats a missing opt-in callback as NOT opted in', async () => {
    // Fail closed: a deployment that forgot to wire the flag must not send
    // repositories to a third party by default.
    const gateway = createAnalysisGateway({ hosts: [], t3: vi.fn() });
    await expect(gateway.complete('p', t3Opts)).rejects.toThrow(TierNotPermittedError);
  });

  it('surfaces host saturation rather than queueing invisibly', async () => {
    const gateway = createAnalysisGateway({ hosts: [], concurrencyCap: 1 });
    await expect(gateway.complete('p', t2Opts)).rejects.toThrow(HostUnavailableError);
  });
});

describe('scheduling (FR-ANALYSIS-8)', () => {
  it('never enqueues when the policy is off', () => {
    expect(shouldEnqueue('off', 'webhook').enqueue).toBe(false);
    expect(shouldEnqueue('off', 'manual').enqueue).toBe(false);
  });

  it('distinguishes manual from off', () => {
    // Collapsing them either spends model time nobody asked for, or makes a
    // "Review now" button do nothing.
    expect(shouldEnqueue('manual', 'webhook').enqueue).toBe(false);
    expect(shouldEnqueue('manual', 'manual').enqueue).toBe(true);
    expect(shouldEnqueue('auto', 'webhook').enqueue).toBe(true);
  });

  it('keys jobs on the head sha, so a new push IS reviewed again', () => {
    const base = { repoId: 1, prNumber: 2, dimension: 'security' as const };
    expect(reviewJobId({ ...base, headSha: 'aaa' })).not.toBe(reviewJobId({ ...base, headSha: 'bbb' }));
    // …while a redelivered webhook for the same commit is deduped.
    expect(reviewJobId({ ...base, headSha: 'aaa' })).toBe(reviewJobId({ ...base, headSha: 'aaa' }));
  });

  it('separates a paused host from a busy one (NFR-7)', () => {
    // An unreachable host needs a human; a saturated one needs patience. One
    // banner for both sends people hunting a fault that is not there.
    expect(analysisStatus([{ baseUrl: 'h', reachable: false, inFlight: 0 }], 1).state).toBe('paused');
    expect(analysisStatus([{ baseUrl: 'h', reachable: true, inFlight: 1 }], 1).state).toBe('saturated');
    expect(analysisStatus([{ baseUrl: 'h', reachable: true, inFlight: 0 }], 1).banner).toBeNull();
    expect(analysisStatus([], 1).state).toBe('paused');
  });
});
