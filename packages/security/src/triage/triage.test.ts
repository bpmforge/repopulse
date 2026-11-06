import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAnalysisGateway,
  type AnalysisGateway,
  type CompleteOpts,
  type CompleteResult,
  type T2Host,
} from '@repopulse/analysis';
import { hitDedupKey, type FileRuleRunner } from '../patches/verify.js';
import { proveTriagePatch } from './patch.js';
import { buildTriagePrompt, loadTriageChecklist } from './prompt.js';
import { runTriage } from './run.js';
import { validateTriageAnswer } from './schema.js';
import { sliceAround } from './slice.js';
import type { TriageCandidate } from './types.js';

// W19-04. What matters: a verdict must cite lines it was shown (matched back to
// our copy), nothing is ever dismissed, a patch survives only if the SAME rules
// no longer fire, and the triage ROLE rides the routing chain and local-only.

const SOURCE = [
  'import { exec } from "child_process";',
  '',
  'export function run(cmd: string) {',
  '  return exec(cmd);',
  '}',
  '',
  'export function safe() {',
  '  return exec("ls -la");',
  '}',
].join('\n');

function candidate(over: Partial<TriageCandidate['finding']> = {}, risk = 5): TriageCandidate {
  return {
    finding: {
      dedupKey: `k-${over.lineStart ?? 4}`,
      scannerKey: 'semgrep',
      ruleId: 'bpm-exec-user-input',
      title: 'Command built from a parameter',
      dimension: 'sast',
      file: 'src/run.ts',
      lineStart: 4,
      lineEnd: 4,
      evidenceQuote: 'return exec(cmd);',
      ...over,
    },
    reachability: { tier: null },
    source: SOURCE,
    effectiveRisk: risk,
  };
}

const answer = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    verdict: 'real',
    confidence: 4,
    citations: [{ line: 4, quote: 'return exec(cmd);' }],
    rationale: 'cmd flows straight to exec',
    vex_justification: null,
    vex_statement: null,
    patch: null,
    ...o,
  });

function scripted(reply: (n: number, opts: CompleteOpts) => string) {
  const calls: { prompt: string; opts: CompleteOpts }[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt, opts): Promise<CompleteResult> {
      calls.push({ prompt, opts });
      return {
        text: reply(calls.length, opts),
        model: 'scripted',
        tokensIn: 1,
        tokensOut: 1,
        costUsd: null,
        durationMs: 1,
      };
    },
    async health() {
      return { ok: true };
    },
  };
  return { gateway, calls };
}

const meta = { repoId: '1', prNumber: 0, initiator: 'test' };

describe('sliceAround', () => {
  it('numbers the lines and keeps the finding inside', () => {
    const s = sliceAround(SOURCE, 'a.ts', 4, 4, 10_000, 2);
    expect(s.startLine).toBe(2);
    expect(s.endLine).toBe(6);
    expect(s.text).toContain('4|   return exec(cmd);');
    expect(s.lines[2]).toBe('  return exec(cmd);');
  });

  it('keeps real file line numbers when the source is only a window of the file', () => {
    // The stored context (W18-32) is a few lines starting mid-file: line 40 onwards.
    const window = ['const a = 1;', 'danger(userInput);', 'const b = 2;'].join('\n');
    const s = sliceAround(window, 'a.ts', 41, 41, 5000, 25, 40);
    expect(s.startLine).toBe(40);
    expect(s.endLine).toBe(42);
    expect(s.text).toContain('41| danger(userInput);');
    expect(s.lines[1]).toBe('danger(userInput);');
    // A citation is validated against the real numbering.
    const ok = validateTriageAnswer(
      {
        verdict: 'real',
        confidence: 4,
        citations: [{ line: 41, quote: 'danger(userInput)' }],
        rationale: 'r',
      },
      s,
    );
    expect(ok.ok && ok.answer.citations[0]).toEqual({
      file: 'a.ts',
      line: 41,
      text: 'danger(userInput);',
    });
    expect(
      validateTriageAnswer(
        { verdict: 'real', confidence: 4, citations: [{ line: 1, quote: 'x' }], rationale: 'r' },
        s,
      ),
    ).toMatchObject({ ok: false, reason: 'citation_not_found' });
  });

  it('shrinks the context to fit a small budget but never drops the finding', () => {
    const long = Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};`);
    long[199] = 'dangerous(userInput);';
    const s = sliceAround(long.join('\n'), 'a.ts', 200, 200, 120, 25);
    expect(s.text).toContain('dangerous(userInput);');
    expect(s.endLine - s.startLine).toBeLessThan(50);
    expect(s.truncated).toBe(false);
  });

  it("says so when the finding's own span is over budget", () => {
    const long = Array.from({ length: 300 }, (_, i) => `const value${i} = ${i} + ${i};`).join('\n');
    const s = sliceAround(long, 'a.ts', 1, 300, 150);
    expect(s.truncated).toBe(true);
    expect(s.startLine).toBe(1);
  });
});

describe('the prompt', () => {
  it('carries the rule provenance and the slice, and says reachability was not computed', () => {
    const c = candidate({
      ruleDescription: 'exec() with a non-literal argument',
      packVersion: 'v3',
      cwe: 78,
    });
    const p = buildTriagePrompt({
      finding: c.finding,
      reachability: c.reachability,
      slice: sliceAround(SOURCE, c.finding.file, 4, 4, 5000),
      checklist: loadTriageChecklist(),
    });
    expect(p.text).toContain('bpm-exec-user-input');
    expect(p.text).toContain('pack v3');
    expect(p.text).toContain('CWE: 78');
    expect(p.text).toContain('Reachability: not computed for this scanner');
    expect(p.text).toContain('4|   return exec(cmd);');
    expect(p.checklistVersion).toBe('triage.v1');
  });

  it('names a reachability tier when there is one', () => {
    const c = candidate();
    const p = buildTriagePrompt({
      finding: c.finding,
      reachability: { tier: 'symbol_reachable', detail: 'called from routes.ts:12' },
      slice: sliceAround(SOURCE, c.finding.file, 4, 4, 5000),
    });
    expect(p.text).toContain('Reachability: symbol_reachable — called from routes.ts:12');
  });

  it('writes the verdict values out rather than leaving a placeholder', () => {
    const c = candidate();
    const p = buildTriagePrompt({
      finding: c.finding,
      reachability: c.reachability,
      slice: sliceAround(SOURCE, c.finding.file, 4, 4, 5000),
    });
    expect(p.text).toContain('"real" or "likely_false_positive" or "needs_human"');
    expect(p.text).not.toMatch(/<verdict>/);
  });
});

describe('validateTriageAnswer — uncited verdicts are rejected', () => {
  const slice = sliceAround(SOURCE, 'src/run.ts', 4, 4, 5000, 3);

  it("accepts a cited verdict and records OUR text for the line, not the model's", () => {
    const r = validateTriageAnswer(
      JSON.parse(answer({ citations: [{ line: 4, quote: 'exec(cmd)' }] })),
      slice,
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.answer.citations).toEqual([
        { file: 'src/run.ts', line: 4, text: '  return exec(cmd);' },
      ]);
  });

  it('rejects a verdict that cites nothing', () => {
    const r = validateTriageAnswer(JSON.parse(answer({ citations: [] })), slice);
    expect(r).toMatchObject({ ok: false, reason: 'uncited' });
  });

  it('rejects a line outside the lines shown', () => {
    const r = validateTriageAnswer(
      JSON.parse(answer({ citations: [{ line: 400, quote: 'x' }] })),
      slice,
    );
    expect(r).toMatchObject({ ok: false, reason: 'citation_not_found' });
  });

  it('rejects a quote that is not on the line it names', () => {
    const r = validateTriageAnswer(
      JSON.parse(answer({ citations: [{ line: 4, quote: 'eval(somethingElse)' }] })),
      slice,
    );
    expect(r).toMatchObject({ ok: false, reason: 'citation_not_found' });
  });

  it('rejects an unknown verdict as malformed', () => {
    expect(validateTriageAnswer({ ...JSON.parse(answer()), verdict: 'safe' }, slice)).toMatchObject(
      { ok: false, reason: 'malformed' },
    );
  });

  it('rejects a VEX justification on a real verdict, and keeps one on a false positive', () => {
    const bad = validateTriageAnswer(
      JSON.parse(answer({ vex_justification: 'vulnerable_code_not_present' })),
      slice,
    );
    expect(bad).toMatchObject({ ok: false, reason: 'ungrounded' });
    const good = validateTriageAnswer(
      JSON.parse(
        answer({
          verdict: 'likely_false_positive',
          vex_justification: 'inline_mitigations_already_exist',
          vex_statement: 'input validated',
        }),
      ),
      slice,
    );
    expect(good.ok && good.answer.vex).toEqual({
      justification: 'inline_mitigations_already_exist',
      statement: 'input validated',
    });
  });

  it('drops a patch offered with a non-real verdict, and says so', () => {
    const r = validateTriageAnswer(
      JSON.parse(answer({ verdict: 'needs_human', patch: '--- a\n+++ b' })),
      slice,
    );
    expect(r.ok && r.answer.patchText).toBeNull();
    expect(r.ok && r.answer.notes[0]).toMatch(/dropped a patch/);
  });
});

describe('runTriage', () => {
  it('routes by the triage role, records the answer, and never dismisses', async () => {
    const { gateway, calls } = scripted(() => answer());
    const r = await runTriage([candidate()], { gateway, meta });
    expect(calls[0]?.opts.meta.role).toBe('triage');
    expect(r.proposals[0]).toMatchObject({
      verdict: 'real',
      model: 'scripted',
      checklistVersion: 'triage.v1',
    });
    expect(r.funnel).toMatchObject({
      candidates: 1,
      selected: 1,
      triaged: 1,
      accepted: 1,
      dismissed: 0,
    });
  });

  it('reconciles its funnel: top-N cut, call budget, accepted + rejected', async () => {
    const { gateway } = scripted((n) => (n === 2 ? 'garbage' : answer()));
    const cands = [1, 2, 3, 4, 5].map((i) =>
      candidate({ lineStart: i, lineEnd: i, dedupKey: `k${i}` }, 10 - i),
    );
    const r = await runTriage(cands, { gateway, meta, limit: 4, maxCalls: 4 });
    const f = r.funnel;
    expect(f.candidates).toBe(f.selected + f.skipped.below_top_n);
    expect(f.selected).toBe(f.triaged + f.skipped.budget_exhausted);
    expect(f.triaged).toBe(f.accepted + Object.values(f.rejected).reduce((a, b) => a + b, 0));
    expect(f.skipped.below_top_n).toBe(1);
    expect(f.dismissed).toBe(0);
  });

  it('triages highest effective risk first, ties by dedup key', async () => {
    const { gateway, calls } = scripted(() => answer());
    const cands = [
      candidate({ dedupKey: 'b' }, 1),
      candidate({ dedupKey: 'a' }, 9),
      candidate({ dedupKey: 'c' }, 9),
    ];
    await runTriage(cands, { gateway, meta, limit: 2 });
    expect(calls).toHaveLength(2);
    const r = await runTriage(cands, { gateway: scripted(() => answer()).gateway, meta, limit: 2 });
    expect(r.proposals.map((p) => p.dedupKey)).toEqual(['a', 'c']);
  });

  it('retries a malformed or uncited answer once, with the problem appended', async () => {
    const { gateway, calls } = scripted((n) => (n === 1 ? answer({ citations: [] }) : answer()));
    const r = await runTriage([candidate()], { gateway, meta });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toMatch(/previous answer was rejected/);
    expect(r.proposals).toHaveLength(1);
    // W27-04: the answer and its corrective retry are short verdicts.
    expect(calls.map((c) => c.opts.reasoning)).toEqual(['none', 'none']);
  });

  it('does NOT ask again after a citation to a line it was not shown', async () => {
    const { gateway, calls } = scripted(() => answer({ citations: [{ line: 400, quote: 'x' }] }));
    const r = await runTriage([candidate()], { gateway, meta });
    expect(calls).toHaveLength(1);
    expect(r.proposals).toEqual([]);
    expect(r.rejections[0]).toMatchObject({ reason: 'citation_not_found' });
    expect(r.funnel.rejected.citation_not_found).toBe(1);
  });

  it('treats needs_human as a normal answer', async () => {
    const { gateway } = scripted(() => answer({ verdict: 'needs_human' }));
    const r = await runTriage([candidate()], { gateway, meta });
    expect(r.funnel.verdicts.needs_human).toBe(1);
    expect(r.rejections).toEqual([]);
  });

  it('sizes the slice to the probed context window', async () => {
    const big = Array.from(
      { length: 2000 },
      (_, i) => `const value${i} = compute(${i}) + other(${i});`,
    ).join('\n');
    const c = { ...candidate({ lineStart: 1000, lineEnd: 1000, evidenceQuote: 'x' }), source: big };
    const small = scripted(() => answer({ citations: [{ line: 1000, quote: 'const value999' }] }));
    await runTriage([c], { gateway: small.gateway, meta, contextWindow: 4096 });
    const large = scripted(() => answer({ citations: [{ line: 1000, quote: 'const value999' }] }));
    await runTriage([c], { gateway: large.gateway, meta, contextWindow: null });
    expect(small.calls[0]!.prompt.length).toBeLessThan(large.calls[0]!.prompt.length);
  });
});

describe('the triage role rides the routing chain and local-only (W19-02)', () => {
  const ok = (model: string) =>
    new Response(
      JSON.stringify({
        model,
        choices: [{ message: { content: answer() }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  const lan = (n: number): T2Host => ({
    baseUrl: `http://10.0.0.${n}:1234/v1`,
    modelSlot: `lan-${n}`,
    providerId: n,
    name: `LAN ${n}`,
  });
  const cloud: T2Host = {
    baseUrl: 'https://api.example-llm.com/v1',
    modelSlot: 'c',
    providerId: 9,
    name: 'Hosted',
  };
  const link = (h: T2Host) => ({ host: h, providerName: h.name! });

  it('falls back along the triage chain on a provider error and records the serving link', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      String(url).includes('10.0.0.1') ? new Response('down', { status: 503 }) : ok('lan-2'),
    ) as unknown as typeof fetch;
    const gateway = createAnalysisGateway({
      hosts: [lan(1), lan(2)],
      routing: { localOnly: false, chains: { triage: [link(lan(1)), link(lan(2))] } },
      fetchImpl,
      sleep: async () => {},
    });
    const r = await runTriage([candidate()], { gateway, meta });
    expect(r.proposals[0]?.route).toMatchObject({ providerName: 'LAN 2', linkIndex: 1 });
  });

  it('refuses a triage chain that would leave the network under local-only, sending nothing', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const gateway = createAnalysisGateway({
      hosts: [cloud],
      routing: { localOnly: true, chains: { triage: [link(cloud)] } },
      fetchImpl,
    });
    await expect(runTriage([candidate()], { gateway, meta })).rejects.toThrow(
      /Local-only is on: role "triage" would send to connection "Hosted"/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a proposed patch is re-scanned by the same rules (W18-19 path)', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'triage-'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // A stub rule: fires on `exec(cmd)` — the same shape verify.test.ts uses.
  const runner: FileRuleRunner = {
    key: 'stub',
    scannerKeys: ['semgrep'],
    async run(input) {
      return {
        status: 'succeeded',
        hits: input.source.split('\n').flatMap((text, i) =>
          text.includes('exec(cmd)')
            ? [
                {
                  scannerKey: 'semgrep',
                  ruleId: 'bpm-exec-user-input',
                  dimension: 'sast',
                  file: input.file,
                  lineStart: i + 1,
                  evidenceQuote: text.trim(),
                  title: 'exec',
                },
              ]
            : [],
        ),
      };
    },
  };
  // The finding's key must be the one the findings store would give the rule's
  // hit — that is how the verifier recognises the target after the patch.
  const patchCandidate = (): TriageCandidate => {
    const c = candidate();
    return {
      ...c,
      finding: {
        ...c.finding,
        dedupKey: hitDedupKey({
          scannerKey: 'semgrep',
          ruleId: 'bpm-exec-user-input',
          dimension: 'sast',
          file: 'src/run.ts',
          lineStart: 4,
          evidenceQuote: 'return exec(cmd);',
          title: 'exec',
        }),
      },
    };
  };
  const diff = (to: string) =>
    [
      '--- a/src/run.ts',
      '+++ b/src/run.ts',
      '@@ -3,3 +3,3 @@',
      ' export function run(cmd: string) {',
      '-  return exec(cmd);',
      `+  return ${to};`,
      ' }',
    ].join('\n');

  it('keeps a patch only when the finding is gone, and returns the canonical diff', async () => {
    const p = await proveTriagePatch(patchCandidate(), diff('execFile("ls", [cmd])'), {
      runners: [runner],
      root,
    });
    expect(p.status).toBe('verified');
    expect(p.diff).toContain('execFile');
  });

  it('rejects a patch that leaves the finding in place', async () => {
    const p = await proveTriagePatch(patchCandidate(), diff('exec(cmd)'), {
      runners: [runner],
      root,
    });
    expect(p).toMatchObject({ status: 'rejected', diff: null });
  });

  it('offers no patch when no runner was supplied or no rule re-runs the finding', async () => {
    expect((await proveTriagePatch(candidate(), diff('x'), undefined)).status).toBe(
      'not_attempted',
    );
    const other = candidate({ scannerKey: 'owasp_web' });
    expect(await proveTriagePatch(other, diff('x'), { runners: [runner], root })).toMatchObject({
      status: 'rejected',
      diff: null,
    });
  });

  it('rejects text that is not a usable diff', async () => {
    const p = await proveTriagePatch(candidate(), 'just change it', { runners: [runner], root });
    expect(p).toMatchObject({ status: 'rejected', diff: null });
  });

  it('end to end: a real verdict with a good patch comes back verified, never applied', async () => {
    const { gateway } = scripted(() => answer({ patch: diff('execFile("ls", [cmd])') }));
    const r = await runTriage([patchCandidate()], {
      gateway,
      meta,
      patchProof: { runners: [runner], root },
    });
    expect(r.proposals[0]?.patch).toMatchObject({ status: 'verified' });
    expect(r.funnel.dismissed).toBe(0);
  });
});
