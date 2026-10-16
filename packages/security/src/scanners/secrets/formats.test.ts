import { describe, expect, it } from 'vitest';
import { scanPatch } from './detect.js';
import { loadRulepack } from './rulepack.js';
import { buildSecretFindings } from './scanner.js';
import { FORMAT_SAMPLES, type Charset, type Part } from './formats.data.js';

// The provider formats added in W18-38 (SECURITY_SUITE.md 3.1).
//
// For every candidate rule: a trigger sample it must match, a clean sample it
// must not, and a check that no OTHER rule fires on its trigger — a family of
// prefixed tokens is only worth having if each prefix names exactly one
// provider. Samples are assembled here at run time (see formats.data.ts).

const CHARS: Record<Charset, string> = {
  hex: '0123456789abcdef',
  upperhex: '0123456789ABCDEF',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  lower: 'abcdefghijklmnopqrstuvwxyz0123456789',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  b64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
  b64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  digit: '0123456789',
  bech32: 'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L',
};

/** Deterministic, well-mixed characters: a seeded generator, so a failure reproduces. */
function generate(charset: Charset, n: number, seed: number): string {
  const set = CHARS[charset];
  let state = seed >>> 0 || 1;
  let out = '';
  for (let i = 0; i < n; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += set[(state >>> 8) % set.length];
  }
  return out;
}

function build(parts: Part[], seed: number, shrink = false): string {
  return parts
    .map((p, i) => (typeof p === 'string' ? p : generate(p[0], shrink ? 3 : p[1], seed + i * 7919)))
    .join('');
}

const pack = loadRulepack();
const ruleIds = (line: string): string[] =>
  scanPatch('a.txt', ['@@ -0,0 +1,1 @@', `+${line}`].join('\n'), { rulepack: pack }).map((m) => m.ruleId);

describe('provider formats (W18-38)', () => {
  it('ships at least 100 rules, every new one a shadow candidate', () => {
    expect(pack.rules.length).toBeGreaterThanOrEqual(100);
    const candidates = pack.rules.filter((r) => r.candidate);
    expect(candidates.map((r) => r.id).sort()).toEqual(FORMAT_SAMPLES.map((s) => s.id).sort());
    // The original fifteen keep their meaning: active, not shadow.
    expect(pack.rules.filter((r) => !r.candidate)).toHaveLength(15);
  });

  it.each(FORMAT_SAMPLES.map((s) => [s.id, s] as const))('%s fires on its format and only on it', (id, sample) => {
    const trigger = build(sample.parts, 17);
    const hits = ruleIds(`value = ${trigger}`);
    expect(hits, `trigger for ${id}`).toContain(id);
    // No other candidate claims this token; the only tolerated co-fire is the
    // generic assignment rule, which is a catch-all by design.
    const others = hits.filter((h) => h !== id && h !== 'generic-secret-assignment');
    expect(others, `${id} also fired ${others.join(', ')}`).toEqual([]);

    const clean = build(sample.parts, 17, true);
    expect(ruleIds(`value = ${clean}`), `clean for ${id}`).not.toContain(id);
  });

  it('files a candidate rule as an experimental finding and an original rule as a normal one', () => {
    const sample = FORMAT_SAMPLES.find((s) => s.id === 'huggingface-token')!;
    const patch = (value: string) => ({ path: 'a.env', patch: `@@ -0,0 +1,1 @@\n+TOKEN=${value}` });
    const candidate = buildSecretFindings({ files: [patch(build(sample.parts, 3))] }).find(
      (f) => f.ruleId === 'huggingface-token',
    );
    expect(candidate).toMatchObject({ ruleId: 'huggingface-token', experimental: true });
    expect(candidate!.title).toContain('Hugging Face access token');
    const original = buildSecretFindings({ files: [patch(`ghp_${generate('alnum', 36, 5)}`)] }).find(
      (f) => f.ruleId === 'github-pat',
    );
    expect(original).toBeDefined();
    expect(original!.experimental).toBeUndefined();
  });
});
