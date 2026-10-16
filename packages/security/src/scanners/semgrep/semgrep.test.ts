import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bareRuleId, parseOpengrepOutput, severityOf } from './output.js';
import {
  assertNotRegistryConfig,
  readRulepack,
  RegistryRulesRefusedError,
  runSemgrepScan,
  toIncomingFindings,
} from './scanner.js';

// The semgrep scanner (W8-07, SECURITY_SUITE.md §3.3, FR-SEC-6).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/semgrep');

describe('the licence rule is enforced, not documented', () => {
  it('REFUSES Semgrep registry configs', () => {
    // Their licence bars registry rules for service use. A silently dropped
    // `--config auto` would leave a customer believing they run a
    // 2,000-rule pack while they run six.
    for (const config of ['p/ci', 'p/owasp-top-ten', 'r/javascript', 'auto']) {
      expect(() => assertNotRegistryConfig(config), config).toThrow(RegistryRulesRefusedError);
    }
    expect(() => assertNotRegistryConfig('https://semgrep.dev/c/p/default')).toThrow();
  });

  it('allows an in-house pack reference', () => {
    expect(() => assertNotRegistryConfig('bpm-rulepacks/baseline')).not.toThrow();
    expect(() => assertNotRegistryConfig('/rules/bpm-baseline.v1.yaml')).not.toThrow();
  });
});

describe('the shipped rulepack', () => {
  it('is ours, is readable, and every rule declares what it costs', () => {
    const pack = readRulepack();
    expect(pack.files.length).toBeGreaterThan(0);
    expect(pack.ruleIds.length).toBeGreaterThanOrEqual(6);
    // Every id is namespaced to us: a rule id that could collide with an
    // upstream pack's would make two different checks dedup as one finding.
    for (const id of pack.ruleIds) expect(id.startsWith('bpm-')).toBe(true);
    // The version travels with the pack — a finding is only reproducible
    // against the rules that produced it.
    expect(pack.version).toContain('bpm-baseline.v1.yaml');
  });
});

describe('opengrep output parsing', () => {
  const output = (results: unknown[], errors: unknown[] = []) =>
    JSON.stringify({ version: '1.27.1', results, errors, paths: { scanned: ['/scan/a.js'] } });

  const result = {
    check_id: 'rules.bpm-baseline.v1.bpm-js-eval-dynamic',
    path: '/scan/src/app.js',
    start: { line: 7, col: 3 },
    end: { line: 7, col: 12 },
    extra: {
      message: 'eval() executes whatever string it is given.',
      severity: 'ERROR',
      metadata: { yields: ['rce'], cwe: 'CWE-95: …' },
    },
  };

  it('strips the config-path prefix from a rule id', () => {
    // `--config /rules/pack.yaml` yields `rules.pack.<id>`. The prefix is an
    // artefact of where the file was mounted, and the same rule run from two
    // mount points would otherwise dedup as two different findings.
    expect(bareRuleId('rules.bpm-baseline.v1.bpm-js-eval-dynamic', ['bpm-js-eval-dynamic'])).toBe(
      'bpm-js-eval-dynamic',
    );
    expect(bareRuleId('bpm-js-eval-dynamic', ['bpm-js-eval-dynamic'])).toBe('bpm-js-eval-dynamic');
    // Unknown rule: keep the last segment rather than storing a filesystem
    // path as a rule identifier.
    expect(bareRuleId('some.path.mystery-rule', [])).toBe('mystery-rule');
  });

  it('maps severities and reserves 5', () => {
    // Severity 5 in this product means confirmed and immediately exploitable.
    // A pattern match over a syntax tree saw a shape, not an exploit.
    expect(severityOf('ERROR')).toBe(4);
    expect(severityOf('WARNING')).toBe(3);
    expect(severityOf('INFO')).toBe(2);
    expect(severityOf('anything else')).toBe(2);
  });

  it('carries yields through for the chainer', () => {
    const parsed = parseOpengrepOutput({
      stdout: output([result]),
      knownRuleIds: ['bpm-js-eval-dynamic'],
      rootDir: '/scan',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.findings[0]?.yields).toEqual(['rce']);
    // Path relative to the mount: a stored finding must not carry the
    // container's mount point into the UI.
    expect(parsed.findings[0]?.file).toBe('src/app.js');
  });

  it('SURFACES tool errors rather than swallowing them', () => {
    // A rulepack that failed to load produces zero findings and exit 0, which
    // is indistinguishable from a clean repository unless someone reads this.
    const parsed = parseOpengrepOutput({
      stdout: output([], [{ message: 'Invalid YAML file /rules/pack.yaml' }]),
      knownRuleIds: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.findings).toEqual([]);
    expect(parsed.toolErrors[0]).toContain('Invalid YAML');
  });

  it('rejects output that is not opengrep JSON', () => {
    expect(parseOpengrepOutput({ stdout: '', knownRuleIds: [] }).ok).toBe(false);
    expect(parseOpengrepOutput({ stdout: 'not json', knownRuleIds: [] }).ok).toBe(false);
    expect(parseOpengrepOutput({ stdout: '{"results":[{}]}', knownRuleIds: [] }).ok).toBe(false);
  });

  it('stores findings as UNVERIFIED-equivalent confidence, not as certainties', () => {
    const parsed = parseOpengrepOutput({
      stdout: output([result]),
      knownRuleIds: ['bpm-js-eval-dynamic'],
      rootDir: '/scan',
    });
    if (!parsed.ok) throw new Error('parse failed');
    const [finding] = toIncomingFindings(parsed.findings);
    expect(finding?.dimension).toBe('sast');
    expect(finding?.confidence).toBe(3);
    expect(finding?.scannerKey).toBe('semgrep');
    expect(finding?.yields).toEqual({ rce: true });
  });
});

// The live half: the real engine, the real rulepack, the real sandbox.
const scanImage = (() => {
  try {
    const out = execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      stdio: 'pipe',
    }).toString();
    return out
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
})();

const describeIfScanImage = scanImage ? describe : describe.skip;

describeIfScanImage('opengrep, actually run in the sandbox (FR-SEC-6)', () => {
  it('finds the seeded vulnerabilities and nothing in the safe fixture', async () => {
    // The assertion the whole ticket exists for. Unit tests on the parser only
    // prove the parser; this proves the rules fire, inside the profile, on real
    // code — including that the rulepack reached a container with no network.
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'vulnerable'),
      budget: { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 },
      ...(scanImage ? { image: scanImage } : {}),
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.toolErrors).toEqual([]);
    const ids = [...new Set(result.findings.map((f) => f.ruleId))].sort();
    expect(ids).toEqual([
      'bpm-js-child-process-concat',
      'bpm-js-eval-dynamic',
      'bpm-js-jwt-verify-disabled',
      'bpm-js-math-random-token',
      'bpm-js-sql-string-concat',
      'bpm-js-weak-hash',
      'bpm-py-eval-dynamic',
      'bpm-py-jwt-verify-disabled',
      'bpm-py-random-token',
      'bpm-py-sql-string-build',
      'bpm-py-subprocess-shell-concat',
      'bpm-py-weak-hash',
      // The disabled-safety pack (W18-04) flags the same shell-fed-a-variable
      // call as bpm-py-subprocess-shell-concat; both packs are mounted on every run.
      'bpm-sec-shell-dynamic-command-py',
    ]);
    // Tool AND pack version, stamped from the image rather than assumed.
    expect(result.toolVersions.opengrep).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.toolVersions.rulepack).toContain('bpm-baseline.v1.yaml');
  }, 300_000);

  it('reports NOTHING on the safe fixture — a false positive is a person interrupted', async () => {
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'safe'),
      budget: { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 },
      ...(scanImage ? { image: scanImage } : {}),
    });
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.findings.map((f) => `${f.ruleId}:${f.lineStart}`)).toEqual([]);
  }, 300_000);
});
