import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHAIN_VOCABULARY } from '../chainer/build.js';
import { readRulepack, runSemgrepScan } from './scanner.js';

// Disabled safety (W18-04): TLS verification, CORS with credentials, a shell
// fed a variable, CSRF — each switched off by hand.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_FILE = path.resolve(HERE, '../../../rulepacks/semgrep/bpm-baseline.safety.v1.yaml');
const FIXTURES = path.resolve(HERE, '../../../fixtures/disabled-safety');

const RULES = [
  'bpm-sec-cors-credentials-any-origin-go',
  'bpm-sec-cors-credentials-any-origin-java',
  'bpm-sec-cors-credentials-any-origin-js',
  'bpm-sec-cors-credentials-any-origin-py',
  'bpm-sec-csrf-disabled-java',
  'bpm-sec-csrf-disabled-js',
  'bpm-sec-csrf-disabled-py',
  'bpm-sec-shell-dynamic-command-go',
  'bpm-sec-shell-dynamic-command-java',
  'bpm-sec-shell-dynamic-command-js',
  'bpm-sec-shell-dynamic-command-py',
  'bpm-sec-tls-verify-disabled-go',
  'bpm-sec-tls-verify-disabled-java',
  'bpm-sec-tls-verify-disabled-js',
  'bpm-sec-tls-verify-disabled-py',
];

// The triggering fixtures are real Go, Java and Python, so the language
// baseline packs (mounted alongside this one on every run) fire on the same
// defects. Listed apart from RULES: these are not this pack's rules.
const SIBLING_PACK_RULES = [
  'bpm-go-shell-exec-dynamic',
  'bpm-go-tls-insecure-skip-verify',
  'bpm-java-command-concat',
  'bpm-java-hostname-verification-disabled',
  'bpm-java-trust-all-certificates',
  'bpm-py-subprocess-shell-concat',
];

describe('the disabled-safety pack', () => {
  const text = readFileSync(PACK_FILE, 'utf8');
  const ids = readRulepack(path.dirname(PACK_FILE)).ruleIds.filter((id) => RULES.includes(id));

  it('is loaded by the SAST scanner, with every rule ours and declared', () => {
    // Same directory as the baseline pack: readRulepack lists it, so the
    // semgrep scanner mounts it on every run.
    expect(readRulepack().files).toContain('bpm-baseline.safety.v1.yaml');
    expect([...ids].sort()).toEqual(RULES);
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    expect(
      count(/^ +provenance: written for RepoPulse; not derived from any registry pack$/gm),
    ).toBe(RULES.length);
    // Shadow until promoted: the semgrep scanner reads this to stamp findings
    // experimental.
    expect(count(/^ +lifecycle: candidate$/gm)).toBe(RULES.length);
    expect(text).not.toContain('semgrep.dev');
  });

  it('yields only chain vocabulary, so the chainer can use every finding', () => {
    for (const m of text.matchAll(/yields: \[([^\]]*)\]/g)) {
      for (const term of (m[1] as string).split(',').map((t) => t.trim().replace(/'/g, ''))) {
        expect(CHAIN_VOCABULARY as readonly string[], term).toContain(term);
      }
    }
  });

  it('keeps ERROR for the shell rules: the only switch that alone hands over execution', () => {
    // Severity 4 here means rce; the TLS, CORS and CSRF switches need an
    // attacker on the path or on a page the victim visits as well.
    const blocks = text.split(/\n {2}- id: /).slice(1);
    for (const block of blocks) {
      const id = block.split('\n')[0] as string;
      const severity = /severity: (\w+)/.exec(block)?.[1];
      expect(severity, id).toBe(id.includes('shell') ? 'ERROR' : 'WARNING');
    }
  });
});

// The live half: the real engine, in the sandbox, over the fixtures.
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

describeIfScanImage('disabled-safety golden set', () => {
  const budget = { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 };

  it('every rule fires on the triggering fixtures', async () => {
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'triggering'),
      budget,
      ...(scanImage ? { image: scanImage } : {}),
    });
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.toolErrors).toEqual([]);
    expect([...new Set(result.findings.map((f) => f.ruleId))].sort()).toEqual(
      [...RULES, ...SIBLING_PACK_RULES].sort(),
    );
  }, 300_000);

  it('NOTHING fires on the clean fixtures', async () => {
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'clean'),
      budget,
      ...(scanImage ? { image: scanImage } : {}),
    });
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.findings.map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`)).toEqual([]);
  }, 300_000);
});
