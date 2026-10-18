import { describe, expect, it, vi } from 'vitest';
import {
  buildTweakPrompt,
  clusterTriageFalsePositives,
  runTriageTweakPass,
  type TriageJudgement,
} from './triage-clusters.js';

// W19-06. AI-judged false positives become PROPOSALS for a person: a cluster
// needs enough confident verdicts, more false positives than real ones, and the
// real ones travel into the prompt as cases the narrower rule must still catch.
// Nothing here can store anything but `proposed`.

const j = (over: Partial<TriageJudgement> = {}): TriageJudgement => ({
  ruleId: 'bpm-ch-noisy',
  file: 'src/a.ts',
  evidence: 'console.log(x)',
  verdict: 'likely_false_positive',
  confidence: 4,
  citedLines: ['  console.log(`${name}: ${count}`);'],
  rationale: 'a CLI whose interface is its console',
  ...over,
});
const many = (n: number, over: Partial<TriageJudgement> = {}) =>
  Array.from({ length: n }, (_, i) => j({ file: `src/f${i}.ts`, ...over }));

describe('clusterTriageFalsePositives', () => {
  it("clusters confident false positives of one rule, with the reviewer's reasons", () => {
    const [c] = clusterTriageFalsePositives(many(4));
    expect(c).toMatchObject({
      origin: 'ai_triage',
      sourceRuleId: 'bpm-ch-noisy',
      size: 4,
      realCount: 0,
    });
    expect(c!.rationales[0]).toMatch(/CLI/);
    expect(c!.samples[0]!.evidence).toContain('console.log(x)');
    expect(c!.samples[0]!.evidence).toContain('${count}'); // the cited line rides along
  });

  it('ignores a cluster below the minimum size - two verdicts are a disagreement, not a pattern', () => {
    expect(clusterTriageFalsePositives(many(2))).toEqual([]);
  });

  it('ignores low-confidence verdicts', () => {
    expect(clusterTriageFalsePositives(many(5, { confidence: 2 }))).toEqual([]);
    expect(clusterTriageFalsePositives([...many(3), ...many(2, { confidence: 1 })])[0]!.size).toBe(
      3,
    );
  });

  it('does not count needs_human as a false positive, and reports how many there were', () => {
    const c = clusterTriageFalsePositives([...many(3), ...many(4, { verdict: 'needs_human' })]);
    expect(c[0]).toMatchObject({ size: 3, needsHumanCount: 4 });
  });

  it('does not tweak a rule the model mostly confirms: false positives must outnumber real ones', () => {
    const mostlyReal = [...many(3), ...many(3, { verdict: 'real' })];
    expect(clusterTriageFalsePositives(mostlyReal)).toEqual([]);
    expect(clusterTriageFalsePositives([...many(4), ...many(3, { verdict: 'real' })])).toHaveLength(
      1,
    );
  });

  it('carries the real verdicts of that rule as cases the narrower rule must still catch', () => {
    const [c] = clusterTriageFalsePositives([
      ...many(4),
      j({ verdict: 'real', evidence: 'console.log(password)', file: 'src/auth.ts' }),
    ]);
    expect(c!.mustStillCatch).toEqual([{ file: 'src/auth.ts', evidence: 'console.log(password)' }]);
  });

  it('skips findings with no rule, and keeps rules apart', () => {
    const out = clusterTriageFalsePositives([
      ...many(3, { ruleId: null }),
      ...many(3, { ruleId: 'a' }),
      ...many(4, { ruleId: 'b' }),
    ]);
    expect(out.map((c) => c.sourceRuleId)).toEqual(['b', 'a']);
  });
});

describe('buildTweakPrompt', () => {
  it('says the examples are AI judgements, not confirmed, and lists what must still match', () => {
    const [c] = clusterTriageFalsePositives([
      ...many(4),
      j({ verdict: 'real', evidence: 'console.log(password)', file: 'src/auth.ts' }),
    ]);
    const p = buildTweakPrompt(c!);
    expect(p).toMatch(/AI judgements, NOT confirmed by a person/);
    expect(p).toMatch(/MUST still match these/);
    expect(p).toContain('console.log(password)');
    expect(p).toContain('reviewer: a CLI whose interface is its console');
    expect(p).toMatch(/BOTH fixtures are required/);
  });
});

describe('runTriageTweakPass', () => {
  const VALID = {
    id: 'slop.narrower-console',
    domain: 'slop',
    layer: 'llm',
    severity: 2,
    languages: ['ts'],
    checklistItem: "Is this console output the tool's interface?",
    fixtures: { trigger: ['console.log(secret)'], clean: ['console.log(report)'] },
  };
  function harness(text: string) {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => (
          inserted.push(v),
          { onConflictDoNothing: async () => undefined }
        ),
      }),
    } as never;
    const complete = vi.fn(async () => ({
      text,
      model: 'm',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: null,
      durationMs: 1,
    }));
    return { db, inserted, complete, gateway: { complete, health: vi.fn() } as never };
  }

  it('skips by name with no gateway, and by a different name with no cluster', async () => {
    const h = harness('{}');
    expect(
      await runTriageTweakPass({ db: h.db, workspaceId: 1, judgements: many(4) }),
    ).toMatchObject({ status: 'skipped', skippedReason: 'no_gateway' });
    expect(
      await runTriageTweakPass({
        db: h.db,
        workspaceId: 1,
        gateway: h.gateway,
        judgements: many(1),
      }),
    ).toMatchObject({ status: 'skipped', skippedReason: 'no_clusters' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('stores a PROPOSED rule with ai_triage provenance, calls the triage role, and nothing else', async () => {
    const h = harness(JSON.stringify(VALID));
    const r = await runTriageTweakPass({
      db: h.db,
      workspaceId: 7,
      gateway: h.gateway,
      judgements: many(4),
      now: new Date('2026-10-18T00:00:00Z'),
    });
    expect(r).toMatchObject({ status: 'succeeded', clusters: 1, proposed: 1, rejected: 0 });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      workspaceId: 7,
      ruleId: 'slop.narrower-console',
      status: 'proposed',
    });
    expect(h.inserted[0]!.provenance).toMatchObject({
      source: 'llm_draft:ai_triage',
      author: 'analysis-gateway',
      date: '2026-10-18',
    });
    const opts = (h.complete.mock.calls[0] as unknown as [string, { meta: { role: string } }])[1];
    expect(opts.meta.role).toBe('triage');
  });

  it('cannot be talked into a higher status or its own provenance by the model', async () => {
    const h = harness(
      JSON.stringify({
        ...VALID,
        status: 'active',
        provenance: {
          source: 'experts:R-01',
          license: 'MIT',
          author: 'a person',
          date: '2020-01-01',
        },
      }),
    );
    await runTriageTweakPass({ db: h.db, workspaceId: 1, gateway: h.gateway, judgements: many(4) });
    expect(h.inserted[0]!.status).toBe('proposed');
    expect(h.inserted[0]!.provenance).toMatchObject({
      source: 'llm_draft:ai_triage',
      author: 'analysis-gateway',
    });
  });

  it('throws away a draft that fails validation, and counts it', async () => {
    const h = harness(JSON.stringify({ ...VALID, fixtures: { trigger: ['x'], clean: [] } }));
    const r = await runTriageTweakPass({
      db: h.db,
      workspaceId: 1,
      gateway: h.gateway,
      judgements: many(4),
    });
    expect(r).toMatchObject({ proposed: 0, rejected: 1 });
    expect(h.inserted).toEqual([]);
    const garbage = harness('not json');
    expect(
      await runTriageTweakPass({
        db: garbage.db,
        workspaceId: 1,
        gateway: garbage.gateway,
        judgements: many(4),
      }),
    ).toMatchObject({ rejected: 1 });
  });

  it('has no way to touch an existing rule: the store it is given can only insert', async () => {
    // The db handed in has no update/delete/select. If the pass ever tried to
    // promote or edit a rule it would throw and report `failed`.
    const h = harness(JSON.stringify(VALID));
    const r = await runTriageTweakPass({
      db: h.db,
      workspaceId: 1,
      gateway: h.gateway,
      judgements: many(4),
    });
    expect(r.status).toBe('succeeded');
  });
});
