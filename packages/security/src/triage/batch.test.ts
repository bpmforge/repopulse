import { describe, expect, it } from 'vitest';
import {
  budgetForContext,
  type AnalysisGateway,
  type CompleteOpts,
  type CompleteResult,
} from '@repopulse/analysis';
import {
  packTriageBatch,
  parseTriageBatchAnswer,
  runTriageBatch,
  TRIAGE_BATCH_MAX,
} from './batch.js';
import { buildTriagePrompt, loadTriageChecklist } from './prompt.js';
import { prepareTriageHit } from './run.js';
import {
  TRIAGE_BATCH_PROMPT_VERSION,
  TRIAGE_CHECKLIST_VERSION,
  type TriageCandidate,
} from './types.js';

// W22-14: several hits of one rule per call. Each hit is shown whole, answers
// by its own id, and is validated against ITS lines only; a missing, doubled
// or failing item rejects that hit alone. One hit = today's single-hit call.

const RUN_SOURCE = [
  'import { exec } from "child_process";',
  '',
  'export function run(cmd: string) {',
  '  return exec(cmd);',
  '}',
].join('\n');
// A window of another file that starts at line 40.
const JOB_SOURCE = ['const a = 1;', 'exec(job.command);', 'const b = 2;'].join('\n');

function hitA(over: Partial<TriageCandidate['finding']> = {}): TriageCandidate {
  return {
    finding: {
      dedupKey: 'k-a',
      scannerKey: 'semgrep',
      ruleId: 'exec-user-input',
      title: 'Command built from a parameter (A)',
      dimension: 'sast',
      file: 'src/run.ts',
      lineStart: 4,
      lineEnd: 4,
      evidenceQuote: 'return exec(cmd);',
      ...over,
    },
    reachability: { tier: null },
    source: RUN_SOURCE,
    effectiveRisk: 5,
  };
}

function hitB(over: Partial<TriageCandidate['finding']> = {}): TriageCandidate {
  return {
    finding: {
      dedupKey: 'k-b',
      scannerKey: 'semgrep',
      ruleId: 'exec-user-input',
      title: 'Command built from a parameter (B)',
      dimension: 'sast',
      file: 'src/job.ts',
      lineStart: 41,
      lineEnd: 41,
      evidenceQuote: 'exec(job.command);',
      ...over,
    },
    reachability: { tier: null },
    source: JOB_SOURCE,
    sourceStartLine: 40,
    effectiveRisk: 4,
  };
}

const item = (hit: string, o: Record<string, unknown> = {}) => ({
  hit,
  verdict: 'real',
  confidence: 4,
  citations: [{ line: 4, quote: 'return exec(cmd);' }],
  rationale: 'cmd flows straight to exec',
  vex_justification: null,
  vex_statement: null,
  patch: null,
  ...o,
});
const B_CITES = { citations: [{ line: 41, quote: 'exec(job.command);' }] };

function scripted(reply: (n: number) => string) {
  const calls: { prompt: string; opts: CompleteOpts }[] = [];
  const gateway: AnalysisGateway = {
    async complete(prompt, opts): Promise<CompleteResult> {
      calls.push({ prompt, opts });
      return {
        text: reply(calls.length),
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
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('the batched triage prompt', () => {
  it('holds each hit once, with its own id, flagged lines and numbered lines, and the checklist once', () => {
    const plan = packTriageBatch([hitA(), hitB()], { contextWindow: 32_768, maxHits: 4 });
    expect(plan.hits.map((h) => h.id)).toEqual(['H1', 'H2']);
    const text = plan.prompt!.text;
    expect(plan.prompt!.checklistVersion).toBe(TRIAGE_BATCH_PROMPT_VERSION);
    expect(TRIAGE_BATCH_PROMPT_VERSION).not.toBe(TRIAGE_CHECKLIST_VERSION);
    expect(count(text, loadTriageChecklist())).toBe(1);
    expect(count(text, '## Hit H1')).toBe(1);
    expect(count(text, '## Hit H2')).toBe(1);
    expect(count(text, 'Flagged lines: 4-4 of src/run.ts')).toBe(1);
    expect(count(text, 'Flagged lines: 41-41 of src/job.ts')).toBe(1);
    expect(count(text, '4|   return exec(cmd);')).toBe(1);
    expect(count(text, '41| exec(job.command);')).toBe(1);
    // H1's lines sit under H1, H2's under H2.
    const h2 = text.indexOf('## Hit H2');
    expect(text.indexOf('4|   return exec(cmd);')).toBeLessThan(h2);
    expect(text.indexOf('41| exec(job.command);')).toBeGreaterThan(h2);
    expect(count(text, 'Rule: exec-user-input')).toBe(1);
    expect(text).toMatch(/Respond ONLY with a JSON array/);
    expect(text).toContain('{"hit":"H1"');
  });

  it('shows each hit exactly what its single-hit call would (never cut for another hit)', () => {
    const checklist = loadTriageChecklist();
    const plan = packTriageBatch([hitA(), hitB()], {
      contextWindow: 32_768,
      maxHits: 4,
      checklist,
    });
    for (const h of plan.hits) {
      const alone = prepareTriageHit(h.candidate, 32_768 * 0.75 - 3000, checklist);
      expect(h.prepared.slice).toEqual(alone.slice);
      expect(plan.prompt!.text).toContain(h.prepared.slice.text);
    }
  });

  it('asks the performance impact question for each hit of a performance rule only', () => {
    const perf = { dimension: 'performance', ruleId: 'copy-in-loop' };
    const p = packTriageBatch([hitA(perf), hitB(perf)], { maxHits: 4 }).prompt!.text;
    expect(p).toContain('For each hit whose verdict is "real"');
    expect(p).toContain('"impact":null or "material"');
    const s = packTriageBatch([hitA(), hitB()], { maxHits: 4 }).prompt!.text;
    expect(s).not.toContain('"impact"');
  });
});

describe('packTriageBatch', () => {
  it('one hit is no batch: today’s single-hit prompt', () => {
    const plan = packTriageBatch([hitA(), hitB()], { maxHits: 1 });
    expect(plan.hits).toHaveLength(1);
    expect(plan.left).toHaveLength(1);
    expect(plan.prompt).toBeNull();
  });

  it('stops at the first hit of another rule, and at the ceiling', () => {
    const plan = packTriageBatch([hitA(), hitB({ ruleId: 'other' }), hitB()], { maxHits: 4 });
    expect(plan.hits).toHaveLength(1);
    expect(plan.left).toHaveLength(2);
    const many = Array.from({ length: 12 }, (_, i) => hitA({ dedupKey: `k${i}` }));
    expect(packTriageBatch(many, { maxHits: 50 }).hits).toHaveLength(TRIAGE_BATCH_MAX);
  });

  it('shrinks the batch to what fits the window whole, and leaves the rest for another call', () => {
    const big = Array.from(
      { length: 60 },
      (_, i) => `  const v${i} = compute(${i}, "x".repeat(40));`,
    );
    const source = [...big.slice(0, 30), '  return exec(cmd);', ...big.slice(30)].join('\n');
    const mk = (k: string) => ({ ...hitA({ dedupKey: k, lineStart: 31, lineEnd: 31 }), source });
    const roomy = packTriageBatch([mk('1'), mk('2'), mk('3')], {
      contextWindow: 32_768,
      maxHits: 3,
    });
    expect(roomy.hits).toHaveLength(3);
    const two = packTriageBatch([mk('1'), mk('2')], { contextWindow: 32_768, maxHits: 2 });
    // A window whose prompt budget is one token short of the two-hit prompt.
    let window = Math.ceil((two.prompt!.tokens + 64 + 3000) / 0.75);
    while (budgetForContext(window).promptTokens - 64 >= two.prompt!.tokens) window -= 1;
    const tight = packTriageBatch([mk('1'), mk('2'), mk('3')], {
      contextWindow: window,
      maxHits: 3,
    });
    expect(tight.hits).toHaveLength(1);
    expect(tight.left.map((c) => c.finding.dedupKey)).toEqual(['2', '3']);
    expect(tight.prompt).toBeNull();
    // The one that went is whole: the same slice it had in the roomy batch.
    expect(tight.hits[0]!.prepared.slice).toEqual(roomy.hits[0]!.prepared.slice);
    expect(tight.hits[0]!.prepared.slice.truncated).toBe(false);
  });
});

describe('parseTriageBatchAnswer', () => {
  it('maps each item to its hit by id, in any order', () => {
    const m = parseTriageBatchAnswer(JSON.stringify([item('H2'), item('h1')]), ['H1', 'H2']);
    expect(m.get('H1')).toMatchObject({ ok: true, raw: { hit: 'h1' } });
    expect(m.get('H2')).toMatchObject({ ok: true, raw: { hit: 'H2' } });
  });

  it('a missing or doubled item fails only its own hit; an unknown id is ignored', () => {
    const m = parseTriageBatchAnswer(
      '```json\n' + JSON.stringify([item('H1'), item('H3'), item('H3'), item('H9')]) + '\n```',
      ['H1', 'H2', 'H3'],
    );
    expect(m.get('H1')!.ok).toBe(true);
    expect(m.get('H2')).toEqual({ ok: false, reason: 'malformed', detail: 'no answer for hit H2' });
    expect(m.get('H3')).toMatchObject({ ok: false, detail: 'hit H3 was answered 2 times' });
  });

  it('accepts one array wrapped in an object, and prose around the array', () => {
    const wrapped = parseTriageBatchAnswer(JSON.stringify({ answers: [item('H1')] }), ['H1']);
    expect(wrapped.get('H1')!.ok).toBe(true);
    const prose = parseTriageBatchAnswer(`Here: ${JSON.stringify([item('H1')])} done`, ['H1']);
    expect(prose.get('H1')!.ok).toBe(true);
  });

  it('an answer that is not a JSON array fails every hit', () => {
    const m = parseTriageBatchAnswer('I think they are fine.', ['H1', 'H2']);
    expect([...m.values()].every((v) => !v.ok)).toBe(true);
  });
});

describe('runTriageBatch', () => {
  it('one call for the batch; each hit validated against its own lines, recorded as the batch prompt', async () => {
    const plan = packTriageBatch([hitA(), hitB()], { maxHits: 4 });
    const { gateway, calls } = scripted(() =>
      JSON.stringify([item('H1'), item('H2', { verdict: 'needs_human', ...B_CITES })]),
    );
    const r = await runTriageBatch(plan, { gateway, meta });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.meta.checklistVersion).toBe(TRIAGE_BATCH_PROMPT_VERSION);
    expect(calls[0]!.opts.meta.role).toBe('triage');
    expect(calls[0]!.opts.reasoning).toBe('none'); // W27-04: a verdict, no long reasoning
    expect(r.batched).toBe(true);
    expect(r.calls).toBe(1);
    expect(r.proposals.map((p) => [p.dedupKey, p.verdict, p.checklistVersion])).toEqual([
      ['k-a', 'real', TRIAGE_BATCH_PROMPT_VERSION],
      ['k-b', 'needs_human', TRIAGE_BATCH_PROMPT_VERSION],
    ]);
    expect(r.proposals[1]!.citations).toEqual([
      { file: 'src/job.ts', line: 41, text: 'exec(job.command);' },
    ]);
    expect(r.funnel).toMatchObject({ candidates: 2, triaged: 2, accepted: 2, dismissed: 0 });
  });

  it("a citation of hit A's lines cannot validate hit B", async () => {
    const plan = packTriageBatch([hitA(), hitB()], { maxHits: 4 });
    // H2 cites line 4 of src/run.ts: shown, but under H1, not under H2.
    const { gateway } = scripted(() =>
      JSON.stringify([
        item('H1'),
        item('H2', { citations: [{ line: 4, quote: 'return exec(cmd);', file: 'src/run.ts' }] }),
      ]),
    );
    const r = await runTriageBatch(plan, { gateway, meta });
    expect(r.proposals.map((p) => p.dedupKey)).toEqual(['k-a']);
    expect(r.rejections).toEqual([
      expect.objectContaining({ dedupKey: 'k-b', reason: 'citation_not_found' }),
    ]);
    // Same file, other lines: hit B's window starts at line 40, so line 4 is not under it.
    const sameFile = packTriageBatch([hitA(), hitB({ file: 'src/run.ts' })], { maxHits: 4 });
    const r2 = await runTriageBatch(sameFile, {
      gateway: scripted(() => JSON.stringify([item('H1'), item('H2')])).gateway,
      meta,
    });
    expect(r2.proposals.map((p) => p.dedupKey)).toEqual(['k-a']);
    expect(r2.rejections[0]).toMatchObject({ dedupKey: 'k-b', reason: 'citation_not_found' });
  });

  it('a missing, doubled or invalid item rejects only that hit', async () => {
    const third = hitB({ dedupKey: 'k-c' });
    const fourth = hitB({ dedupKey: 'k-d' });
    const plan = packTriageBatch([hitA(), hitB(), third, fourth], { maxHits: 4 });
    expect(plan.hits).toHaveLength(4);
    const { gateway, calls } = scripted(() =>
      JSON.stringify([
        item('H1'),
        // H2: no answer. H3: answered twice. H4: uncited.
        item('H3', B_CITES),
        item('H3', B_CITES),
        item('H4', { citations: [] }),
      ]),
    );
    const r = await runTriageBatch(plan, { gateway, meta });
    expect(calls).toHaveLength(1); // no batch-level retry
    expect(r.proposals.map((p) => p.dedupKey)).toEqual(['k-a']);
    expect(r.rejections.map((x) => [x.dedupKey, x.reason])).toEqual([
      ['k-b', 'malformed'],
      ['k-c', 'malformed'],
      ['k-d', 'uncited'],
    ]);
    expect(r.funnel).toMatchObject({
      triaged: 4,
      accepted: 1,
      rejected: { malformed: 2, uncited: 1, citation_not_found: 0, ungrounded: 0 },
    });
  });

  it('a one-hit plan is today’s single-hit call: same prompt, version and corrective retry', async () => {
    const plan = packTriageBatch([hitA()], { maxHits: 4 });
    let n = 0;
    const { gateway, calls } = scripted(() =>
      ++n === 1 ? 'not json' : JSON.stringify(item('H1')),
    );
    const r = await runTriageBatch(plan, { gateway, meta, maxCalls: 2 });
    expect(r.batched).toBe(false);
    expect(calls).toHaveLength(2);
    const single = buildTriagePrompt({
      finding: hitA().finding,
      reachability: { tier: null },
      slice: plan.hits[0]!.prepared.slice,
    });
    expect(calls[0]!.prompt).toBe(single.text);
    expect(calls[0]!.opts.meta.checklistVersion).toBe(TRIAGE_CHECKLIST_VERSION);
    expect(r.proposals[0]!.checklistVersion).toBe(TRIAGE_CHECKLIST_VERSION);
  });

  it('a gateway error throws, as runTriage does', async () => {
    const plan = packTriageBatch([hitA(), hitB()], { maxHits: 4 });
    const gateway: AnalysisGateway = {
      async complete() {
        throw new Error('timeout');
      },
      async health() {
        return { ok: true };
      },
    };
    await expect(runTriageBatch(plan, { gateway, meta })).rejects.toThrow('timeout');
  });
});
