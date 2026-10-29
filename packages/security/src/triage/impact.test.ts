import { describe, expect, it } from 'vitest';
import type { AnalysisGateway, CompleteResult } from '@repopulse/analysis';
import { buildTriagePrompt, IMPACT_QUESTION } from './prompt.js';
import { runTriage } from './run.js';
import { validateTriageAnswer } from './schema.js';
import { sliceAround } from './slice.js';
import type { TriageCandidate, TriageFinding } from './types.js';

// W22-03 (2026-10-29): measured on outline, the judge confirmed copy-in-a-loop
// hits over five editor extensions as "real" with no way to say "real but too
// small to matter". A performance hit's answer may now carry an impact.

const SOURCE = [
  'const EXTENSIONS = [Bold, Italic, Link];',
  'export function build() {',
  '  let out = [];',
  '  for (const e of EXTENSIONS) out = [...out, e.rules];',
  '  return out;',
  '}',
].join('\n');
const slice = sliceAround(SOURCE, 'src/ExtensionManager.ts', 4, 4, 10_000);

const finding = (dimension: string): TriageFinding => ({
  dedupKey: 'k-4',
  scannerKey: 'performance',
  ruleId: 'bpm-perf-copy-on-append',
  title: 'Copy on append in a loop',
  dimension,
  file: 'src/ExtensionManager.ts',
  lineStart: 4,
  lineEnd: 4,
  evidenceQuote: 'for (const e of EXTENSIONS) out = [...out, e.rules];',
});

const base = {
  verdict: 'real',
  confidence: 4,
  citations: [{ line: 4, quote: 'out = [...out, e.rules]' }],
  rationale: 'copies the array on every pass',
};

describe('triage answer impact (W22-03)', () => {
  it('is null when absent: answers from before impact existed still parse', () => {
    const r = validateTriageAnswer(base, slice);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer.impact).toBeNull();
      expect(r.answer.impactReason).toBeNull();
    }
  });

  it('keeps an impact and its reason on a real verdict', () => {
    const r = validateTriageAnswer(
      { ...base, impact: 'Negligible', impact_reason: 'line 1: a fixed list of three extensions' },
      slice,
    );
    expect(r.ok && r.answer.impact).toBe('negligible');
    expect(r.ok && r.answer.impactReason).toBe('line 1: a fixed list of three extensions');
    const m = validateTriageAnswer({ ...base, impact: 'material', impact_reason: null }, slice);
    expect(m.ok && m.answer.impact).toBe('material');
  });

  it('drops an impact on a verdict that is not real, and an unknown label, with a note', () => {
    const fp = validateTriageAnswer(
      { ...base, verdict: 'likely_false_positive', impact: 'negligible', impact_reason: 'x' },
      slice,
    );
    expect(fp.ok && fp.answer.impact).toBeNull();
    expect(fp.ok && fp.answer.notes.join(' ')).toMatch(/impact/);
    const odd = validateTriageAnswer({ ...base, impact: 'small' }, slice);
    expect(odd.ok).toBe(true);
    expect(odd.ok && odd.answer.impact).toBeNull();
  });

  it('records a negligible impact with no reason as unknown: holding a fix back needs evidence', () => {
    const r = validateTriageAnswer({ ...base, impact: 'negligible', impact_reason: ' ' }, slice);
    expect(r.ok && r.answer.impact).toBe('unknown');
  });
});

describe('triage prompt asks for impact on performance hits only (W22-03)', () => {
  it('asks a performance hit, and adds the fields to the answer shape', () => {
    const p = buildTriagePrompt({
      finding: finding('performance'),
      reachability: { tier: null },
      slice,
      checklist: '# checklist',
    });
    expect(p.text).toContain(IMPACT_QUESTION);
    expect(p.text).toContain('"impact":null or "material" or "negligible" or "unknown"');
    expect(p.text).toContain('"impact_reason"');
  });

  it('does not ask a security or slop hit', () => {
    for (const dimension of ['sast', 'security', 'slop']) {
      const p = buildTriagePrompt({
        finding: finding(dimension),
        reachability: { tier: null },
        slice,
        checklist: '# checklist',
      });
      expect(p.text).not.toContain('How much it matters');
      expect(p.text).not.toContain('"impact"');
    }
  });

  it('asks with an evidence packet too, the packet answer shape kept', () => {
    const p = buildTriagePrompt({
      finding: finding('performance'),
      reachability: { tier: null },
      slice,
      checklist: '# checklist',
      packetText: '## Evidence\n1| x',
    });
    expect(p.text).toContain('"file":"only for a line from a file other than the flagged one');
    expect(p.text).toContain('"impact_reason"');
  });
});

describe('runTriage carries impact onto the proposal for performance only (W22-03)', () => {
  const gatewayAnswering = (text: string): AnalysisGateway => ({
    async complete(): Promise<CompleteResult> {
      return { text, model: 'scripted', tokensIn: 1, tokensOut: 1, costUsd: null, durationMs: 1 };
    },
    async health() {
      return { ok: true };
    },
  });
  const cand = (dimension: string): TriageCandidate => ({
    finding: finding(dimension),
    reachability: { tier: null },
    source: SOURCE,
    effectiveRisk: 3,
  });
  const reply = JSON.stringify({
    ...base,
    impact: 'negligible',
    impact_reason: 'line 1: three fixed extensions',
  });
  const meta = { repoId: '1', prNumber: 0, initiator: 'test' };

  it('keeps it on a performance hit, drops it elsewhere', async () => {
    const perf = await runTriage([cand('performance')], { gateway: gatewayAnswering(reply), meta });
    expect(perf.proposals[0]?.impact).toBe('negligible');
    expect(perf.proposals[0]?.impactReason).toBe('line 1: three fixed extensions');
    expect(perf.funnel.dismissed).toBe(0);
    const sast = await runTriage([cand('sast')], { gateway: gatewayAnswering(reply), meta });
    expect(sast.proposals[0]?.verdict).toBe('real');
    expect(sast.proposals[0]?.impact).toBeNull();
  });
});
