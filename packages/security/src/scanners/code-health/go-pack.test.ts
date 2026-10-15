import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRulepack, runSemgrepScan } from '../semgrep/scanner.js';

// The Go pack (W18-12): anti-slop, logging, perf and security-baseline
// variants, each in its own file beside the JavaScript one so the directories'
// readers pick them up unchanged.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULEPACKS = path.resolve(HERE, '../../../rulepacks');
const FIXTURES = path.resolve(HERE, '../../../fixtures/go');

const PACKS = {
  codeHealth: {
    dir: path.join(RULEPACKS, 'code-health'),
    files: ['anti-slop.go.v1.yaml', 'logging.go.v1.yaml'],
    fixtures: path.join(FIXTURES, 'code-health'),
    golden: [
      'bpm-ch-go-discarded-error',
      'bpm-ch-go-panic-in-library',
      'bpm-ch-go-stub-as-feature',
      'bpm-ch-go-swallowed-error',
      'bpm-ch-go-what-comment',
      'bpm-log-go-injection',
      'bpm-log-go-log-and-return',
      'bpm-log-go-print-in-prod',
      'bpm-log-go-secret-field',
    ],
  },
  perf: {
    dir: path.join(RULEPACKS, 'code-health/perf'),
    files: ['perf.go.v1.yaml'],
    fixtures: path.join(FIXTURES, 'perf'),
    golden: [
      'bpm-perf-go-db-call-in-loop',
      'bpm-perf-go-defer-in-loop',
      'bpm-perf-go-regex-compile-in-loop',
      'bpm-perf-go-string-concat-in-loop',
    ],
  },
  baseline: {
    dir: path.join(RULEPACKS, 'semgrep'),
    files: ['bpm-baseline.go.v1.yaml'],
    fixtures: path.join(FIXTURES, 'semgrep'),
    golden: [
      'bpm-go-http-server-no-timeout',
      'bpm-go-math-rand-secret',
      'bpm-go-shell-exec-dynamic',
      'bpm-go-sql-string-build',
      'bpm-go-tls-insecure-skip-verify',
      'bpm-go-weak-hash-credential',
    ],
  },
} as const;

const ruleBlocks = (text: string): string[] => text.split(/\n(?= {2}- id: )/).slice(1);

describe('the Go pack is ours and ships in shadow', () => {
  for (const [name, pack] of Object.entries(PACKS)) {
    it(`${name}: every rule is bpm-, Go-only, has provenance and is a candidate`, () => {
      const ids: string[] = [];
      for (const file of pack.files) {
        const text = readFileSync(path.join(pack.dir, file), 'utf8');
        for (const marker of ['go.lang.security', 'semgrep.dev', 'p/golang', 'r2c']) {
          expect(text, `${file}: ${marker}`).not.toContain(marker);
        }
        for (const block of ruleBlocks(text)) {
          const id = /- id: (\S+)/.exec(block)?.[1] ?? '';
          ids.push(id);
          expect(id.startsWith('bpm-'), id).toBe(true);
          expect(block, id).toContain('languages: [go]');
          expect(block, id).toContain(
            'provenance: written for RepoPulse; not derived from any registry pack',
          );
          // §8.2: a rule that ships in code starts as a candidate.
          expect(block, id).toContain('lifecycle: candidate');
        }
      }
      expect(ids.sort()).toEqual([...pack.golden]);
      // The directory reader sees them, alongside whatever else lives there.
      const loaded = readRulepack(pack.dir).ruleIds;
      for (const id of pack.golden) expect(loaded, id).toContain(id);
    });
  }

  it('keeps logging ids under bpm-log- (the logging scanner keeps only those)', () => {
    const text = readFileSync(path.join(PACKS.codeHealth.dir, 'logging.go.v1.yaml'), 'utf8');
    for (const block of ruleBlocks(text)) expect(block).toMatch(/- id: bpm-log-go-/);
  });

  it('keeps code health below security severity, and quotes no speedups', () => {
    for (const pack of [PACKS.codeHealth, PACKS.perf]) {
      for (const file of pack.files) {
        const text = readFileSync(path.join(pack.dir, file), 'utf8');
        expect(text, file).not.toContain('severity: ERROR');
      }
    }
    const perf = readFileSync(path.join(PACKS.perf.dir, 'perf.go.v1.yaml'), 'utf8');
    expect(perf).not.toMatch(/\d+x\b/);
  });
});

// The golden half, by the real engine in the sandbox — as the other packs.
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

describeIfScanImage('Go golden sets (W18-12)', () => {
  const budget = { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 };
  const goIds = (ids: string[]) => ids.filter((id) => /^bpm-(ch-go|log-go|perf-go|go)-/.test(id));

  for (const [name, pack] of Object.entries(PACKS)) {
    it(`${name}: every Go rule fires on the triggering fixture`, async () => {
      const result = await runSemgrepScan({
        targetDir: path.join(pack.fixtures, 'triggering'),
        rulepackDir: pack.dir,
        budget,
        ...(scanImage ? { image: scanImage } : {}),
      });
      expect(result.status, result.error ?? '').toBe('succeeded');
      expect(result.toolErrors).toEqual([]);
      const ids = [...new Set(result.findings.map((f) => f.ruleId))].sort();
      expect(goIds(ids)).toEqual([...pack.golden]);
    }, 300_000);

    it(`${name}: NOTHING fires on the clean (near-miss) fixture`, async () => {
      const result = await runSemgrepScan({
        targetDir: path.join(pack.fixtures, 'clean'),
        rulepackDir: pack.dir,
        budget,
        ...(scanImage ? { image: scanImage } : {}),
      });
      expect(result.status, result.error ?? '').toBe('succeeded');
      expect(result.findings.map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`)).toEqual([]);
    }, 300_000);
  }
});
