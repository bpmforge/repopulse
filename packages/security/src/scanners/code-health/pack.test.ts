import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRulepack, runSemgrepScan } from '../semgrep/scanner.js';

// The code-health rulepack (W9-01, CODE_HEALTH_SUITE.md §1/§3, FR-CH-1).
//
// Two things are under test and only one of them is the rules. The other is the
// LICENCE POSITION: this pack exists because Semgrep's registry rules cannot be
// used in a service, so a test that would notice a registry rule arriving is
// part of the deliverable, not paperwork.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_DIR = path.resolve(HERE, '../../../rulepacks/code-health');
const FIXTURES = path.resolve(HERE, '../../../fixtures/code-health');

const packFiles = readdirSync(PACK_DIR).filter((f) => f.endsWith('.yaml'));
const packText = packFiles.map((f) => readFileSync(path.join(PACK_DIR, f), 'utf8')).join('\n');

describe('licence gate: nothing here came from the registry', () => {
  it('carries no Semgrep registry rule identifiers', () => {
    // Registry rules are namespaced by language.framework.category — importing
    // one, even "adapted", is the same licence violation with extra steps.
    for (const marker of [
      'javascript.lang.security',
      'typescript.react',
      'python.lang.security',
      'generic.secrets',
      'semgrep.dev',
      'p/ci',
      'p/owasp',
      '--config auto',
    ]) {
      expect(packText, marker).not.toContain(marker);
    }
  });

  it('gives every rule an id of ours and a provenance note', () => {
    const ids = readRulepack(PACK_DIR).ruleIds;
    expect(ids.length).toBeGreaterThanOrEqual(12);
    for (const id of ids) expect(id.startsWith('bpm-'), id).toBe(true);
    // One provenance line per rule, so the claim is checkable file by file
    // rather than asserted once in a header nobody re-reads.
    const provenance = packText.match(/provenance:/g) ?? [];
    expect(provenance.length).toBe(ids.length);
  });

  it('names the source rule each anti-slop check implements', () => {
    // R-xx ids are our own prior art (bpm-opencode-experts); carrying them
    // makes the pack auditable against the inventory in §1.
    const antiSlop = readFileSync(path.join(PACK_DIR, 'anti-slop.v1.yaml'), 'utf8');
    for (const source of ['R-01', 'R-02', 'R-10', 'R-13', 'R-14', 'R-16', 'R-27', 'R-29']) {
      expect(antiSlop, source).toContain(`source: ${source}`);
    }
  });

  it('records a LIMITATION wherever a rule is a proxy for a judgement', () => {
    // The what-comment and prose-padding rules match phrasings, not redundancy.
    // Saying so in the pack is what stops the next reader assuming coverage
    // the rules do not have.
    const antiSlop = readFileSync(path.join(PACK_DIR, 'anti-slop.v1.yaml'), 'utf8');
    expect((antiSlop.match(/limitation:/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('the pack is versioned and stamped', () => {
  it('reports a version built from its files', () => {
    const pack = readRulepack(PACK_DIR);
    expect(pack.version).toContain('anti-slop.v1.yaml');
    expect(pack.version).toContain('logging.v1.yaml');
  });
});

// The golden half: the rules are run, by the real engine, in the sandbox.
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

describeIfScanImage('golden finding set (W9-01)', () => {
  const budget = { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 };

  it('every rule fires on the triggering fixture', async () => {
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'triggering'),
      rulepackDir: PACK_DIR,
      budget,
      ...(scanImage ? { image: scanImage } : {}),
    });

    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.toolErrors).toEqual([]);
    const ids = [...new Set(result.findings.map((f) => f.ruleId))].sort();
    // The golden set. A rule that stops firing is a rule that has quietly
    // become decoration, and the count is what notices.
    expect(ids).toEqual([
      'bpm-ch-emoji-comment',
      'bpm-ch-empty-catch',
      'bpm-ch-prose-padding',
      'bpm-ch-silent-fallback-return',
      'bpm-ch-step-narration',
      'bpm-ch-stub-as-feature',
      'bpm-ch-try-catch-in-loop',
      'bpm-ch-what-comment',
      'bpm-log-and-rethrow',
      'bpm-log-console-in-prod',
      'bpm-log-injection',
      'bpm-log-secret-field',
    ]);
  }, 300_000);

  it('NOTHING fires on the clean fixture', async () => {
    // The half that decides whether anyone keeps the pack switched on. Both
    // clean files do the same jobs as the triggering ones — the difference is
    // that they handle their failures and say why.
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'clean'),
      rulepackDir: PACK_DIR,
      budget,
      ...(scanImage ? { image: scanImage } : {}),
    });
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.findings.map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`)).toEqual([]);
  }, 300_000);

  it('nothing in this pack claims a security severity', async () => {
    // Code health is not exploitability. A slop rule at severity 4 would
    // outrank a real vulnerability in every list that sorts by severity.
    const result = await runSemgrepScan({
      targetDir: path.join(FIXTURES, 'triggering'),
      rulepackDir: PACK_DIR,
      budget,
      ...(scanImage ? { image: scanImage } : {}),
    });
    for (const finding of result.findings) {
      expect(finding.severity, finding.ruleId).toBeLessThanOrEqual(3);
    }
  }, 300_000);
});
