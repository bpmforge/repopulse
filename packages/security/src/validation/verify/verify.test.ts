import { describe, expect, it } from 'vitest';
import type { Database } from '@repopulse/shared';
import type { AnalysisGateway, CompleteOpts, CompleteResult } from '@repopulse/analysis';
import type { ValidatedVulnerability } from '../types.js';
import { loadVerifyChecklist } from './checklist.js';
import { buildEvidenceBlock, buildVerifyPrompt } from './prompt.js';
import { validateVerifyAnswer } from './schema.js';
import { candidatesFrom, selectForVerify, VERIFY_MAX_CALLS } from './select.js';
import { runVerifyPass } from './run.js';
import type { VerifyCandidate } from './types.js';

// W8-15. The tests that matter here are the REJECTIONS: an accepted proposal is
// only trustworthy because the fabricated and the ungrounded ones do not get in.

function vulnerability(over: Partial<ValidatedVulnerability> = {}): ValidatedVulnerability {
  return {
    primaryId: 'CVE-2020-26160',
    aliases: ['GHSA-w73w-5m7g-f7qc'],
    cveId: 'CVE-2020-26160',
    packageName: 'github.com/dgrijalva/jwt-go',
    packageVersion: 'v3.2.0',
    packageType: 'go-module',
    purl: 'pkg:golang/github.com/dgrijalva/jwt-go@v3.2.0',
    severity: 4,
    severityLabel: 'high',
    kev: false,
    epss: 0.0042,
    fixVersions: [],
    locations: ['go.mod'],
    matchType: 'exact-direct-match',
    scope: {
      inResolvedSet: true,
      versionMatches: true,
      scope: { kind: 'prod-direct', depth: 1 },
      manifest: 'go.mod',
      unreadableReason: null,
    },
    usage: {
      status: 'imported',
      unknownReason: null,
      evidence: [
        { file: 'cmd/api/main.go', line: 12, quote: 'import jwt "github.com/dgrijalva/jwt-go"' },
      ],
    },
    reachability: {
      tier: 'symbol_reachable',
      provenBy: 'govulncheck',
      unavailableReason: null,
      callSites: [{ file: 'cmd/api/main.go', line: 41, symbol: 'MapClaims.VerifyAudience' }],
    },
    proposals: [],
    ...over,
  };
}

function candidate(
  over: Partial<ValidatedVulnerability> = {},
  risk = 8,
  key = 'k1',
): VerifyCandidate {
  return { vulnerability: vulnerability(over), effectiveRisk: risk, dedupKey: key };
}

// A gateway that answers from a script and records what it was asked.
function fakeGateway(
  answers: string[],
): AnalysisGateway & { prompts: string[]; opts: CompleteOpts[] } {
  const prompts: string[] = [];
  const opts: CompleteOpts[] = [];
  let call = 0;
  return {
    prompts,
    opts,
    async complete(prompt: string, options: CompleteOpts): Promise<CompleteResult> {
      prompts.push(prompt);
      opts.push(options);
      const text = answers[call] ?? answers[answers.length - 1] ?? '{}';
      call += 1;
      return {
        text,
        model: 'test-model',
        tokensIn: 100,
        tokensOut: 20,
        costUsd: null,
        durationMs: 5,
      };
    },
    async health() {
      return { ok: true };
    },
  };
}

interface RecordedRun {
  values: Record<string, unknown>;
  updates: Record<string, unknown>[];
}

/** The narrowest db that runVerifyPass touches: one insert, one update. */
function fakeDb(): { db: Database; runs: RecordedRun[] } {
  const runs: RecordedRun[] = [];
  const db = {
    insert() {
      return {
        values(values: Record<string, unknown>) {
          return {
            async returning() {
              runs.push({ values, updates: [] });
              return [{ id: runs.length }];
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where() {
              runs[runs.length - 1]?.updates.push(values);
              return [];
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Database, runs };
}

const answer = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    applies: true,
    justification: null,
    confidence: 3,
    reason: 'The package is imported and reached.',
    evidence: [],
    ...over,
  });

describe('V5 checklist asset', () => {
  it('loads the highest version and states the proposal-only rule', () => {
    const checklist = loadVerifyChecklist();
    expect(checklist.version).toMatch(/^dependency-verify\.v\d+$/);
    expect(checklist.prompt).toContain('A human confirms');
    // The default position is that the CVE applies — the adversarial framing is
    // the whole reason this asset exists rather than a generic "is this right?".
    expect(checklist.prompt).toContain('DOES apply');
  });
});

describe('V5 selection', () => {
  it('takes the top N by effective risk, deterministically', () => {
    const candidates = [candidate({}, 3, 'low'), candidate({}, 9, 'high'), candidate({}, 6, 'mid')];
    const selection = selectForVerify(candidates, 2);
    expect(selection.selected.map((c) => c.dedupKey)).toEqual(['high', 'mid']);
    expect(selection.skipped).toEqual([{ candidate: candidates[0], reason: 'below_top_n' }]);
  });

  it('breaks ties on the dedup key so two runs pick the same findings', () => {
    const a = candidate({}, 5, 'bbb');
    const b = candidate({}, 5, 'aaa');
    expect(selectForVerify([a, b], 1).selected[0]!.dedupKey).toBe('aaa');
    expect(selectForVerify([b, a], 1).selected[0]!.dedupKey).toBe('aaa');
  });

  it('never calls a model about a finding a call graph already settled', () => {
    const proven = candidate(
      {
        reachability: {
          tier: 'proven_unreachable',
          provenBy: 'govulncheck',
          unavailableReason: null,
          callSites: [],
        },
      },
      10,
      'proven',
    );
    const selection = selectForVerify([proven, candidate({}, 1, 'other')], 5);
    expect(selection.selected.map((c) => c.dedupKey)).toEqual(['other']);
    expect(selection.skipped).toEqual([
      { candidate: proven, reason: 'already_proven_unreachable' },
    ]);
  });

  it('clamps a caller that asks for more than the hard cap', () => {
    const many = Array.from({ length: 100 }, (_, i) => candidate({}, 100 - i, `k${i}`));
    expect(selectForVerify(many, 500).selected).toHaveLength(VERIFY_MAX_CALLS);
  });

  it('refuses to zip prices onto vulnerabilities it cannot align', () => {
    expect(() => candidatesFrom([vulnerability()], [])).toThrow(/index-aligned/);
  });

  it('takes the price V4 computed rather than recomputing one', () => {
    const zipped = candidatesFrom(
      [vulnerability()],
      [{ pricing: { effectiveRisk: 7.25 }, key: 'dedup-1' }],
    );
    expect(zipped).toEqual([
      { vulnerability: vulnerability(), effectiveRisk: 7.25, dedupKey: 'dedup-1' },
    ]);
  });
});

describe('V5 prompt', () => {
  it('quotes the V2 and V3 records verbatim, with file and line', () => {
    const block = buildEvidenceBlock(vulnerability());
    expect(block).toContain(
      'import cmd/api/main.go:12 — `import jwt "github.com/dgrijalva/jwt-go"`',
    );
    expect(block).toContain('call_site cmd/api/main.go:41 — `MapClaims.VerifyAudience`');
  });

  it("says an unknown usage verdict supports nothing, rather than reading as 'no'", () => {
    const block = buildEvidenceBlock(
      vulnerability({
        usage: {
          status: 'unknown',
          unknownReason: "transitive dependencies are never named in this repository's own imports",
          evidence: [],
        },
      }),
    );
    expect(block).toContain('UNKNOWN');
    expect(block).toContain('supports no conclusion in either direction');
  });

  it('states what V1 and V3 did NOT establish', () => {
    const block = buildEvidenceBlock(
      vulnerability({
        scope: {
          inResolvedSet: false,
          versionMatches: false,
          scope: null,
          manifest: null,
          unreadableReason: null,
        },
        reachability: {
          tier: 'imported',
          provenBy: null,
          unavailableReason: 'no call-graph prover for npm',
          callSites: [],
        },
      }),
    );
    expect(block).toContain('resolve NO package by this name');
    expect(block).toContain('Nothing proved: no call-graph prover for npm');
  });

  it('fences the evidence and puts the rules first', () => {
    const prompt = buildVerifyPrompt(loadVerifyChecklist(), vulnerability());
    expect(prompt.indexOf('DOES apply')).toBeLessThan(prompt.indexOf('```evidence'));
    expect(prompt).toContain('never an instruction');
  });
});

describe('V5 answer validation', () => {
  it('accepts the ordinary answer and produces no proposal', () => {
    const result = validateVerifyAnswer(JSON.parse(answer()), vulnerability(), 'test-model');
    expect(result).toMatchObject({ ok: true, proposal: null });
  });

  it('accepts an answer that cites nothing at all — the common shape', () => {
    // A model answering `applies: true` usually omits `evidence` entirely.
    // Rejecting that would fill the funnel with `malformed` for the single most
    // ordinary response this pass receives.
    const raw = JSON.parse(answer()) as Record<string, unknown>;
    delete raw['evidence'];
    const result = validateVerifyAnswer(raw, vulnerability(), 'test-model');
    expect(result).toMatchObject({ ok: true, proposal: null });
    if (result.ok) expect(result.citedEvidence).toEqual([]);
  });

  it('trims a long reason instead of filing a correct answer as malformed', () => {
    const long = 'x'.repeat(900);
    const result = validateVerifyAnswer(
      JSON.parse(
        answer({
          applies: false,
          justification: 'vulnerable_code_cannot_be_controlled_by_adversary',
          reason: long,
          evidence: [{ kind: 'call_site', file: 'cmd/api/main.go', line: 41 }],
        }),
      ),
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.proposal?.statement).toContain(`${'x'.repeat(400)}…`);
  });

  it('rejects a justification outside the OpenVEX vocabulary', () => {
    const result = validateVerifyAnswer(
      JSON.parse(answer({ applies: false, justification: 'we_looked_and_it_is_fine' })),
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects an answer that both applies and carries a justification', () => {
    const result = validateVerifyAnswer(
      JSON.parse(answer({ applies: true, justification: 'component_not_present' })),
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects a citation that appears in no V2 or V3 record', () => {
    const result = validateVerifyAnswer(
      JSON.parse(answer({ evidence: [{ kind: 'import', file: 'cmd/api/main.go', line: 999 }] })),
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: false, reason: 'evidence_not_found' });
    if (!result.ok) expect(result.detail).toContain('cmd/api/main.go:999');
  });

  it('throws away the whole answer when one citation of several is invented', () => {
    const result = validateVerifyAnswer(
      JSON.parse(
        answer({
          evidence: [
            { kind: 'import', file: 'cmd/api/main.go', line: 12 },
            { kind: 'call_site', file: 'cmd/api/other.go', line: 41 },
          ],
        }),
      ),
      vulnerability(),
      'test-model',
    );
    expect(result.ok).toBe(false);
  });

  it('tolerates a leading ./ on a copied path — transcription, not fabrication', () => {
    const result = validateVerifyAnswer(
      JSON.parse(answer({ evidence: [{ kind: 'import', file: './cmd/api/main.go', line: 12 }] })),
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      // The detail comes from OUR record, never from the model's text.
      expect(result.citedEvidence[0]!.detail).toBe('import jwt "github.com/dgrijalva/jwt-go"');
    }
  });

  it('refuses a not_affected justification supported only by an unknown verdict', () => {
    const result = validateVerifyAnswer(
      JSON.parse(
        answer({
          applies: false,
          justification: 'vulnerable_code_not_present',
          reason: 'Nothing imports it.',
        }),
      ),
      vulnerability({
        usage: { status: 'unknown', unknownReason: 'transitive dependency', evidence: [] },
        reachability: {
          tier: 'manifest_only',
          provenBy: null,
          unavailableReason: 'none',
          callSites: [],
        },
      }),
      'test-model',
    );
    expect(result).toMatchObject({ ok: false, reason: 'ungrounded' });
    if (!result.ok) expect(result.detail).toContain('absence of evidence');
  });

  it('refuses component_not_present when a lockfile resolves the package', () => {
    const result = validateVerifyAnswer(
      JSON.parse(answer({ applies: false, justification: 'component_not_present' })),
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: false, reason: 'ungrounded' });
  });

  it('refuses component_not_present when no manifest could be read at all', () => {
    const result = validateVerifyAnswer(
      JSON.parse(answer({ applies: false, justification: 'component_not_present' })),
      vulnerability({
        scope: {
          inResolvedSet: false,
          versionMatches: false,
          scope: null,
          manifest: null,
          unreadableReason: 'no manifest reader for maven',
        },
      }),
      'test-model',
    );
    expect(result).toMatchObject({ ok: false, reason: 'ungrounded' });
    if (!result.ok) expect(result.detail).toContain('not evidence of absence');
  });

  it('accepts component_not_present when the lockfile was read and does not list it', () => {
    const result = validateVerifyAnswer(
      JSON.parse(
        answer({
          applies: false,
          justification: 'component_not_present',
          reason: 'package-lock.json resolves no package by this name.',
        }),
      ),
      vulnerability({
        scope: {
          inResolvedSet: false,
          versionMatches: false,
          scope: null,
          manifest: 'package-lock.json',
          unreadableReason: null,
        },
      }),
      'test-model',
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.proposal?.justification).toBe('component_not_present');
      // Author, confidence and the limit of the evidence all ride in the
      // statement a human has to agree with.
      expect(result.proposal?.statement).toContain('test-model');
      expect(result.proposal?.statement).toContain('confidence 3/5');
      expect(result.proposal?.statement).toContain('A human confirms');
    }
  });

  it('refuses a claim about code when nothing was cited', () => {
    const result = validateVerifyAnswer(
      JSON.parse(
        answer({
          applies: false,
          justification: 'vulnerable_code_cannot_be_controlled_by_adversary',
          evidence: [],
        }),
      ),
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: false, reason: 'ungrounded' });
    if (!result.ok) expect(result.detail).toContain('rests on nothing');
  });

  it('accepts a cannot-be-controlled claim that cites a real call site', () => {
    const result = validateVerifyAnswer(
      JSON.parse(
        answer({
          applies: false,
          justification: 'vulnerable_code_cannot_be_controlled_by_adversary',
          reason: 'The audience string is a compile-time constant at the only call site.',
          evidence: [{ kind: 'call_site', file: 'cmd/api/main.go', line: 41 }],
        }),
      ),
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.proposal?.statement).toContain('cmd/api/main.go:41');
  });

  it('rejects extra keys rather than answering a question it was not asked', () => {
    const result = validateVerifyAnswer(
      { ...JSON.parse(answer()), severity: 9 },
      vulnerability(),
      'test-model',
    );
    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('V5 pass', () => {
  const base = {
    workspaceId: 1,
    repoId: 2,
    commitSha: 'a'.repeat(40),
    budget: { llmTokens: 100_000 },
  };

  it('makes one Tier-2 call per selected finding and records the run', async () => {
    const { db, runs } = fakeDb();
    const gateway = fakeGateway([answer()]);
    const result = await runVerifyPass({
      ...base,
      db,
      gateway,
      candidates: [candidate({}, 9, 'a'), candidate({}, 8, 'b')],
      scanRunId: 77,
    });

    expect(result.status).toBe('succeeded');
    expect(gateway.prompts).toHaveLength(2);
    expect(gateway.opts.every((o) => o.tier === 'T2')).toBe(true);
    expect(gateway.opts[0]!.meta.initiator).toBe('scanner:dependency_cve:verify');
    expect(result.funnel.verified).toBe(2);
    expect(result.funnel.affirmed).toBe(2);
    expect(result.promptTokens).toBe(200);
    expect(result.outputTokens).toBe(40);

    expect(runs[0]!.values).toMatchObject({
      tier: 2,
      passKind: 'verify',
      dimension: 'security',
      checklistVersion: result.checklistVersion,
    });
    // The scan run is echoed, never written into parent_run_id: that column
    // chains analysis passes, and scan_runs is a different id space.
    expect(runs[0]!.values['parentRunId']).toBeUndefined();
    expect(result.scanRunId).toBe(77);
    expect(runs[0]!.updates[0]).toMatchObject({
      status: 'succeeded',
      modelId: 'test-model',
      promptTokens: 200,
      outputTokens: 40,
    });
  });

  it('chains to a find pass when the caller has one', async () => {
    const { db, runs } = fakeDb();
    await runVerifyPass({
      ...base,
      db,
      gateway: fakeGateway([answer()]),
      candidates: [candidate()],
      parentRunId: 42,
    });
    expect(runs[0]!.values['parentRunId']).toBe(42);
  });

  it('never escalates a scheduled pass to Tier 3', async () => {
    const gateway = fakeGateway([answer()]);
    await runVerifyPass({ ...base, db: fakeDb().db, gateway, candidates: [candidate()] });
    expect(gateway.opts.map((o) => o.tier)).toEqual(['T2']);
  });

  it('writes no run row and calls nothing when there is nothing to verify', async () => {
    const { db, runs } = fakeDb();
    const gateway = fakeGateway([answer()]);
    const result = await runVerifyPass({ ...base, db, gateway, candidates: [] });
    expect(result).toMatchObject({ status: 'skipped', skippedReason: 'no_candidates' });
    expect(runs).toHaveLength(0);
    expect(gateway.prompts).toHaveLength(0);
  });

  it('counts a malformed answer instead of salvaging it', async () => {
    const { db } = fakeDb();
    const result = await runVerifyPass({
      ...base,
      db,
      gateway: fakeGateway(['I think this one is probably fine.']),
      candidates: [candidate()],
    });
    expect(result.funnel.rejected.malformed).toBe(1);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejections[0]!.reason).toBe('malformed');
  });

  it('unwraps a fenced answer, because a fence is formatting and not a wrong answer', async () => {
    const { db } = fakeDb();
    const result = await runVerifyPass({
      ...base,
      db,
      gateway: fakeGateway(['```json\n' + answer() + '\n```']),
      candidates: [candidate()],
    });
    expect(result.funnel.accepted).toBe(1);
  });

  it('stops on the token budget and returns a partial set, not a failure', async () => {
    const { db } = fakeDb();
    const result = await runVerifyPass({
      ...base,
      budget: { llmTokens: 150 },
      db,
      gateway: fakeGateway([answer()]),
      candidates: [candidate({}, 9, 'a'), candidate({}, 8, 'b'), candidate({}, 7, 'c')],
    });
    expect(result.status).toBe('succeeded');
    expect(result.partial).toBe(true);
    // Two calls, not one: the meter charges AFTER an answer is banked, so the
    // budget stops the next call rather than discarding one already paid for.
    expect(result.funnel.verified).toBe(2);
    expect(result.funnel.skipped.budget_exhausted).toBe(1);
    expect(result.proposals).toHaveLength(2);
    // The funnel still adds up on the path where the budget bit — `selected` is
    // the pre-budget cut and the shortfall shows as a skip, not as a smaller
    // intention.
    const funnel = result.funnel;
    expect(funnel.verified + funnel.skipped.budget_exhausted).toBe(funnel.selected);
    expect(
      funnel.selected + funnel.skipped.already_proven_unreachable + funnel.skipped.below_top_n,
    ).toBe(funnel.candidates);
  });

  it('keeps the proposals it already validated when a host dies mid-pass', async () => {
    const { db, runs } = fakeDb();
    let call = 0;
    const gateway: AnalysisGateway = {
      async complete(): Promise<CompleteResult> {
        call += 1;
        if (call > 1) throw new Error('model crashed');
        return {
          text: answer(),
          model: 'test-model',
          tokensIn: 10,
          tokensOut: 5,
          costUsd: null,
          durationMs: 1,
        };
      },
      async health() {
        return { ok: true };
      },
    };
    const result = await runVerifyPass({
      ...base,
      db,
      gateway,
      candidates: [candidate({}, 9, 'a'), candidate({}, 8, 'b')],
    });
    expect(result.status).toBe('failed');
    expect(result.proposals).toHaveLength(1);
    expect(runs[0]!.updates[0]).toMatchObject({ status: 'failed' });
  });

  it('dismisses nothing, whatever the model answers', async () => {
    const { db } = fakeDb();
    const result = await runVerifyPass({
      ...base,
      db,
      gateway: fakeGateway([
        answer({
          applies: false,
          justification: 'vulnerable_code_not_in_execute_path',
          reason: 'No import names it.',
        }),
      ]),
      candidates: [
        candidate(
          {
            usage: { status: 'not_imported', unknownReason: null, evidence: [] },
            reachability: {
              tier: 'manifest_only',
              provenBy: null,
              unavailableReason: 'no prover',
              callSites: [],
            },
          },
          9,
          'a',
        ),
      ],
    });
    expect(result.funnel.dismissed).toBe(0);
    expect(result.funnel.proposed['vulnerable_code_not_in_execute_path']).toBe(1);
    // A proposal, and shaped like every other tier's so triage renders one thing.
    expect(result.proposals[0]!.proposal).toMatchObject({
      justification: 'vulnerable_code_not_in_execute_path',
    });
    expect(result.proposals[0]!.applies).toBe(false);
  });
});
