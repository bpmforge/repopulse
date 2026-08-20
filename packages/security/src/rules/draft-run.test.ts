import { describe, expect, it, vi } from 'vitest';
import { runRuleDraftPass } from './draft-run.js';

// The scheduled drafting pass (W9-07 carry-forward).

const db = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => DISMISSALS }) }),
  }),
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
} as never;

let DISMISSALS: { ruleId: string | null; file: string | null; evidence: string }[] = [];

// Shaped to the REAL rule schema, checked against validateHealthRule rather
// than to what a draft "obviously" looks like — my first version of this
// fixture failed six ways at once and would have made the test assert that
// drafting does not work.
const VALID_DRAFT = JSON.stringify({
  id: 'slop.drafted-rule',
  domain: 'slop',
  // `llm`, not `pack`: a pack rule needs an engineRule path, and a model
  // cannot supply one — it has no rulepack file to point at. That the schema
  // enforces this is the right outcome, not an obstacle to route around.
  layer: 'llm',
  severity: 2,
  languages: ['ts'],
  message: 'A drafted rule about a pattern people kept dismissing.',
  checklistItem: 'Does this call swallow the error it just caught?',
  fixtures: { trigger: ['foo(1)'], clean: ['bar(1)'] },
});

describe('the drafting pass', () => {
  it('SKIPS BY NAME with no gateway, rather than reporting a clean pass', async () => {
    // "No Tier-2 host configured" and "nothing worth drafting" are different
    // answers, and only one of them says anything about the workspace.
    const result = await runRuleDraftPass({ db, workspaceId: 1 });
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toBe('no_gateway');
  });

  it('skips with a DIFFERENT reason when there is nothing to cluster', async () => {
    DISMISSALS = [];
    const gateway = { complete: vi.fn(), health: vi.fn() } as never;
    const result = await runRuleDraftPass({ db, workspaceId: 1, gateway });
    expect(result.skippedReason).toBe('no_clusters');
    // The model is never called for an empty workspace.
    expect((gateway as unknown as { complete: ReturnType<typeof vi.fn> }).complete).not.toHaveBeenCalled();
  });

  it('drafts from a cluster and stores it as PROPOSED', async () => {
    DISMISSALS = Array.from({ length: 4 }, (_, i) => ({
      ruleId: 'bpm-ch-noisy',
      file: `src/a${i}.ts`,
      evidence: 'the same shape people keep dismissing',
    }));
    const complete = vi.fn(
      async (_prompt: string, opts: { tier: string }) => {
        seenTier = opts.tier;
        return { text: VALID_DRAFT, tokensIn: 10, tokensOut: 20 };
      },
    );
    let seenTier = '';
    const result = await runRuleDraftPass({
      db,
      workspaceId: 1,
      gateway: { complete, health: vi.fn() } as never,
    });

    expect(result.status).toBe('succeeded');
    expect(result.drafted).toBe(1);
    // Tier 2, never 3: a scheduled pass must not escalate to a third-party API
    // without a human having opted in.
    expect(seenTier).toBe('T2');
  });

  it('COUNTS a draft the validator threw out rather than swallowing it', async () => {
    DISMISSALS = Array.from({ length: 4 }, () => ({
      ruleId: 'bpm-ch-noisy',
      file: 'src/a.ts',
      evidence: 'x',
    }));
    const result = await runRuleDraftPass({
      db,
      workspaceId: 1,
      gateway: { complete: async () => ({ text: '{"id":"nope"}' }), health: vi.fn() } as never,
    });
    expect(result.drafted).toBe(0);
    expect(result.rejected).toBe(1);
  });

  it('keeps the drafts it already stored when the gateway dies mid-pass', async () => {
    // Throwing away good work because a later call timed out is losing work to
    // tidiness.
    DISMISSALS = ['a', 'b'].flatMap((rule) =>
      Array.from({ length: 4 }, (_, i) => ({ ruleId: rule, file: `src/${rule}${i}.ts`, evidence: rule })),
    );
    let call = 0;
    const result = await runRuleDraftPass({
      db,
      workspaceId: 1,
      gateway: {
        complete: async () => {
          call += 1;
          if (call === 1) return { text: VALID_DRAFT };
          throw new Error('model crashed');
        },
        health: vi.fn(),
      } as never,
    });
    expect(result.status).toBe('failed');
    expect(result.drafted).toBe(1);
    expect(result.error).toContain('model crashed');
  });
});
