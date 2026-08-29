import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { contentDigest, createT3Client, estimateCostUsd } from './client.js';
import { decideEscalation, meetsTrigger } from '../escalation/index.js';
import type { CompleteOpts } from '../gateway/types.js';

// Tier-3 (W7-01, FR-ANALYSIS-7, NFR-9).
//
// NO LIVE CALL IS MADE HERE. The transport is injected; there is no
// ANTHROPIC_API_KEY in this environment and none should be needed to prove the
// egress discipline, which is what these tests are about.

const opts: CompleteOpts = {
  tier: 'T3',
  maxTokens: 4000,
  expectJson: true,
  meta: { repoId: '7', prNumber: 12, dimension: 'security', checklistVersion: 'v1', initiator: 'escalation' },
};

const response = {
  content: [{ type: 'text', text: '{"findings":[]}' }],
  model: 'claude-sonnet-5',
  usage: { input_tokens: 1000, output_tokens: 500 },
};

describe('egress audit', () => {
  it('writes the audit row BEFORE the model call', async () => {
    // An audit that only records successes is not an audit. The order is the
    // control: a call that crashes mid-parse still leaves evidence that this
    // repository's code left the network.
    const order: string[] = [];
    const client = createT3Client({
      apiKey: 'unused',
      recordEgress: async () => {
        order.push('audit');
      },
      createMessage: async () => {
        order.push('call');
        return response;
      },
    });
    await client('prompt', opts);
    expect(order).toEqual(['audit', 'call']);
  });

  it('still has the audit row when the call THROWS', async () => {
    const recordEgress = vi.fn(async () => undefined);
    const client = createT3Client({
      apiKey: 'unused',
      recordEgress,
      createMessage: async () => {
        throw new Error('anthropic 500');
      },
    });
    await expect(client('prompt', opts)).rejects.toThrow('anthropic 500');
    expect(recordEgress).toHaveBeenCalledTimes(1);
  });

  it('records byte count and a content digest of exactly what was sent', async () => {
    let seen: { bytes: number; contentSha256: string } | null = null;
    const client = createT3Client({
      apiKey: 'unused',
      recordEgress: async (r) => {
        seen = { bytes: r.bytes, contentSha256: r.contentSha256 };
      },
      createMessage: async () => response,
    });
    await client('hello diff', opts);
    expect(seen!.bytes).toBe(Buffer.byteLength('hello diff'));
    // The digest is the audit's proof of content: it can be checked against a
    // reconstructed prompt later without storing the code itself.
    expect(seen!.contentSha256).toBe(contentDigest('hello diff'));
  });

  it('carries the initiator and checklist version into the record', async () => {
    let seen: Record<string, unknown> = {};
    const client = createT3Client({
      apiKey: 'unused',
      recordEgress: async (r) => {
        seen = r as unknown as Record<string, unknown>;
      },
      createMessage: async () => response,
    });
    await client('x', opts);
    expect(seen).toMatchObject({ initiator: 'escalation', checklistVersion: 'v1', repoId: '7' });
  });
});

describe('cost', () => {
  it('records a real dollar cost, unlike Tier-2 which records null', async () => {
    const client = createT3Client({
      apiKey: 'unused',
      recordEgress: async () => undefined,
      createMessage: async () => response,
    });
    const result = await client('x', opts);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.tokensIn).toBe(1000);
  });

  it('prices input and output separately', () => {
    // Output is the expensive half; a flat per-token estimate would understate
    // a long review by several multiples.
    const cost = estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, { inputPerMTok: 3, outputPerMTok: 15 });
    expect(cost).toBeCloseTo(3);
    expect(estimateCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, { inputPerMTok: 3, outputPerMTok: 15 })).toBeCloseTo(15);
  });
});

describe('escalation (ANALYSIS_TIERS.md §6)', () => {
  it('escalates a high-severity finding the local model was UNSURE about', () => {
    // The case a stronger model earns its cost on. High severity with high
    // confidence does not need a second opinion; it needs fixing.
    expect(meetsTrigger({ dimension: 'code_health', severity: 5, confidence: 2 })).toMatch(/low confidence/);
    expect(meetsTrigger({ dimension: 'code_health', severity: 5, confidence: 5 })).toBeNull();
  });

  it('escalates security findings from severity 3', () => {
    expect(meetsTrigger({ dimension: 'security', severity: 3, confidence: 5 })).toMatch(/security/);
  });

  it('BADGES rather than sends when the repo has not opted in', () => {
    // Silent egress — sending code because a heuristic thought it important —
    // is the worst thing this subsystem could do.
    const outcome = decideEscalation(
      { dimension: 'security', severity: 4, confidence: 2 },
      { t3OptIn: false },
    );
    expect(outcome.action).toBe('needs_opt_in');
    expect(outcome.reason).toMatch(/flagged, not sent/);
  });

  it('QUEUES rather than drops when the monthly budget is spent', () => {
    // Dropping silently would make a budget limit look like a quality change.
    const outcome = decideEscalation(
      { dimension: 'security', severity: 4, confidence: 2 },
      { t3OptIn: true, budgetUsd: 10, spentUsd: 10 },
    );
    expect(outcome.action).toBe('queued_budget');
  });

  it('reports the opt-in gap BEFORE the budget gap', () => {
    // Checking budget first would send someone to raise a limit that would
    // change nothing, because the repo was never allowed to escalate.
    const outcome = decideEscalation(
      { dimension: 'security', severity: 4, confidence: 2 },
      { t3OptIn: false, budgetUsd: 0, spentUsd: 99 },
    );
    expect(outcome.action).toBe('needs_opt_in');
  });

  it('does nothing when no trigger is met, whatever the permissions', () => {
    expect(decideEscalation({ dimension: 'code_health', severity: 1, confidence: 5 }, { t3OptIn: true }).action).toBe('none');
  });
});

describe('Tier 3 streams too, without exception (W16-39)', () => {
  it('goes through the streaming API, not the buffered one', async () => {
    // Every long generation this product makes is streamed. A non-streamed
    // request sends no response headers until the model has finished, so the
    // only thing bounding it is whatever timeout the transport happens to have
    // — which is exactly how Tier 2 came to die at 301 seconds on undici's
    // default. Anthropic agrees from the other side: it refuses non-streaming
    // requests whose max_tokens implies a long generation.
    //
    // Asserted against the SOURCE because the SDK is imported lazily and only
    // when a real key is configured, so no test can reach the call itself
    // without one. The seam that tests do use (`createMessage`) deliberately
    // bypasses the SDK entirely.
    const src = readFileSync(new URL('./client.ts', import.meta.url).pathname, 'utf8');
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).toContain('client.messages.stream(');
    expect(code).toContain('finalMessage()');
    expect(code).not.toContain('client.messages.create(');
  });
});
