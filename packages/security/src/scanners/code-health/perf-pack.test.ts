import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRulepack, runSemgrepScan } from '../semgrep/scanner.js';

// The per-language performance pack (W9-08, CODE_HEALTH_SUITE.md §9.1).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.resolve(HERE, '../../../rulepacks/code-health/perf');
const FIXTURES = path.resolve(HERE, '../../../fixtures/perf');

describe('the perf pack', () => {
  // Every pack file in the directory, not just v1: language packs (W18-11)
  // live beside it and are held to the same rules.
  const text = readdirSync(PACK_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => readFileSync(path.join(PACK_DIR, f), 'utf8'))
    .join('\n');

  it('is ours, with a provenance line per rule', () => {
    const ids = readRulepack(PACK_DIR).ruleIds;
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of ids) expect(id.startsWith('bpm-perf-'), id).toBe(true);
    expect((text.match(/provenance:/g) ?? []).length).toBe(ids.length);
    expect(text).not.toContain('semgrep.dev');
  });

  it('covers the §9.1 list, including the Python variant', () => {
    for (const rule of [
      'bpm-perf-orm-call-in-loop',
      'bpm-perf-await-in-loop',
      'bpm-perf-sync-io-in-async',
      'bpm-perf-json-deep-clone',
      'bpm-perf-regex-compile-in-loop',
      'bpm-perf-string-concat-in-loop',
      'bpm-perf-unbounded-promise-all',
      'bpm-perf-orm-call-in-loop-py',
    ]) {
      expect(text, rule).toContain(rule);
    }
  });

  it('quotes NO speedup figures', () => {
    // Same rule as performance.v2 (W9-05): a finding citing a benchmark nobody
    // ran, on an engine version nobody checked, is worse than no finding.
    // Including in the comments: this test caught the header quoting the very
    // figure the rule forbids, which is exactly the kind of thing that gets
    // copied out of a comment and into a finding.
    expect(text).not.toMatch(/\d+x\b/);
    expect(text).not.toMatch(/5-20/);
  });

  it('tops out at WARNING, because a slow shape is not exploitable', () => {
    expect(text).not.toContain('severity: ERROR');
    expect(text).not.toContain('severity: CRITICAL');
  });
});

const scanImage = (() => {
  try {
    return execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
})();

const describeIfScanImage = scanImage ? describe : describe.skip;

describeIfScanImage('perf pack golden set', () => {
  const budget = { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 };

  it('every rule fires on the triggering fixtures', async () => {
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'triggering'),
      rulepackDir: PACK_DIR,
      budget,
      ...(scanImage ? { image: scanImage } : {}),
    });
    expect(result.status, result.error ?? '').toBe('succeeded');
    // Zero tool errors is load-bearing: a rule that fails to PARSE takes itself
    // out of the run silently, which is how three of these shipped broken in
    // the first draft (a numeric severity, then an unparseable loop pattern).
    expect(result.toolErrors).toEqual([]);
    const ids = [...new Set(result.findings.map((f) => f.ruleId))].sort();
    expect(ids).toEqual([
      'bpm-perf-await-in-loop',
      'bpm-perf-await-in-loop-py',
      'bpm-perf-blocking-call-in-async-py',
      'bpm-perf-json-deep-clone',
      'bpm-perf-json-deep-clone-py',
      'bpm-perf-orm-call-in-loop',
      'bpm-perf-orm-call-in-loop-py',
      'bpm-perf-regex-compile-in-loop',
      'bpm-perf-regex-compile-in-loop-py',
      'bpm-perf-string-concat-in-loop',
      'bpm-perf-string-concat-in-loop-py',
      'bpm-perf-sync-io-in-async',
      'bpm-perf-unbounded-gather-py',
      'bpm-perf-unbounded-promise-all',
    ]);
  }, 300_000);

  it('NOTHING fires on the clean fixtures', async () => {
    // The half that made three rules better: the clean fixture does the same
    // jobs correctly — one round trip, a hoisted regex, a bounded batch — and
    // every rule that fired on it was refined until it did not.
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'clean'),
      rulepackDir: PACK_DIR,
      budget,
      ...(scanImage ? { image: scanImage } : {}),
    });
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.findings.map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`)).toEqual([]);
  }, 300_000);
});
