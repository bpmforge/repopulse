import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRulepack } from '../semgrep/scanner.js';

// The Swift pack (W18-41): anti-slop, logging and security-baseline rules
// for Swift, each in its own file beside the JS/TS pack it extends.
//
// The live half runs the rules with a LOCAL semgrep/opengrep binary when one is
// on PATH, rather than only inside the scan image: the image is not built on
// every machine, and a Swift rule that silently stops parsing is exactly the
// regression that needs catching wherever the engine exists.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULEPACKS = path.resolve(HERE, '../../../rulepacks');
const FIXTURES = path.resolve(HERE, '../../../fixtures/swift');

interface PackFile {
  file: string;
  prefix: string;
  fixtures: { trigger: string; clean: string };
  /** Code health is not exploitability — capped at WARNING. */
  maxSeverity: 'WARNING' | 'ERROR';
  /** The matcher the rules declare; the property-list pack is generic. */
  language?: string;
}

const PACKS: PackFile[] = [
  {
    file: 'code-health/anti-slop.swift.v1.yaml',
    prefix: 'bpm-ch-sw-',
    fixtures: { trigger: 'code-health/triggering', clean: 'code-health/clean' },
    maxSeverity: 'WARNING',
  },
  {
    // bpm-log- is load-bearing: the logging scanner keeps only those ids.
    file: 'code-health/logging.swift.v1.yaml',
    prefix: 'bpm-log-sw-',
    fixtures: { trigger: 'code-health/triggering', clean: 'code-health/clean' },
    maxSeverity: 'WARNING',
  },
  {
    file: 'semgrep/bpm-baseline.swift.v1.yaml',
    prefix: 'bpm-sw-',
    fixtures: { trigger: 'semgrep/vulnerable', clean: 'semgrep/safe' },
    maxSeverity: 'ERROR',
  },
  {
    file: 'semgrep/bpm-baseline.swift-plist.v1.yaml',
    prefix: 'bpm-sw-',
    fixtures: { trigger: 'semgrep/vulnerable', clean: 'semgrep/safe' },
    maxSeverity: 'ERROR',
    language: 'generic',
  },
];

function idsOf(text: string): string[] {
  return [...text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);
}

describe('the Swift pack is ours and ships in shadow', () => {
  for (const pack of PACKS) {
    const text = readFileSync(path.join(RULEPACKS, pack.file), 'utf8');
    const ids = idsOf(text);

    it(`${pack.file}: ids, provenance and lifecycle on every rule`, () => {
      expect(ids.length).toBeGreaterThanOrEqual(1);
      for (const id of ids) expect(id.startsWith(pack.prefix), id).toBe(true);
      // One line per rule, so the claim is checkable rule by rule.
      expect((text.match(/provenance: written for RepoPulse/g) ?? []).length).toBe(ids.length);
      // New rules start as candidates: their findings are experimental until
      // an admin promotes them on evidence (CODE_HEALTH_SUITE §8.2).
      expect((text.match(/lifecycle: candidate/g) ?? []).length).toBe(ids.length);
      expect(
        (text.match(new RegExp(`languages: \\[${pack.language ?? 'swift'}\\]`, 'g')) ?? []).length,
      ).toBe(ids.length);
    });

    it(`${pack.file}: carries no registry identifiers`, () => {
      for (const marker of [
        'swift.lang.security',
        'semgrep.dev',
        'p/swift',
        'r/swift',
        '--config auto',
      ]) {
        expect(text, marker).not.toContain(marker);
      }
    });

    it(`${pack.file}: severity stays within its domain`, () => {
      if (pack.maxSeverity === 'WARNING') expect(text).not.toContain('severity: ERROR');
      expect(text).not.toMatch(/severity:\s*\d/);
    });
  }

  it('is picked up by the directory loaders the scanners use', () => {
    // readRulepack is not recursive: a file one level too deep is a pack that
    // never runs.
    expect(readRulepack(path.join(RULEPACKS, 'code-health')).files).toEqual(
      expect.arrayContaining(['anti-slop.swift.v1.yaml', 'logging.swift.v1.yaml']),
    );
    expect(readRulepack(path.join(RULEPACKS, 'semgrep')).files).toEqual(
      expect.arrayContaining(['bpm-baseline.swift.v1.yaml', 'bpm-baseline.swift-plist.v1.yaml']),
    );
  });
});

// ---- Live: the real engine over the fixtures ------------------------------

// semgrep phones home for a version check unless told not to, which costs a
// minute behind a proxy; opengrep ignores the variable.
// PYTHONUTF8: the packs contain non-ASCII; the engine's Python layer crashes under a C locale.
const ENGINE_ENV = {
  ...process.env,
  SEMGREP_ENABLE_VERSION_CHECK: '0',
  PYTHONUTF8: '1',
  LC_ALL: 'en_US.UTF-8',
};

const engine = (() => {
  for (const bin of ['opengrep', 'semgrep']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe', timeout: 60_000, env: ENGINE_ENV });
      return bin;
    } catch {
      // not installed; try the next
    }
  }
  return undefined;
})();

interface EngineResult {
  ruleIds: string[];
  locations: string[];
  errors: string[];
}

function runEngine(bin: string, config: string, target: string): EngineResult {
  const args = [
    ...(engine === 'semgrep' ? ['--metrics=off'] : []),
    '--config',
    config,
    '--json',
    '--quiet',
    target,
  ];
  const out = execFileSync(bin, args, {
    env: ENGINE_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
    timeout: 240_000,
  }).toString();
  const parsed = JSON.parse(out) as {
    results: { check_id: string; path: string; start: { line: number } }[];
    errors: { message?: string; type?: unknown }[];
  };
  return {
    ruleIds: parsed.results.map((r) => r.check_id.split('.').pop() as string),
    locations: parsed.results.map(
      (r) => `${r.check_id.split('.').pop()}:${path.relative(target, r.path)}:${r.start.line}`,
    ),
    errors: parsed.errors.map((e) => e.message ?? JSON.stringify(e.type)),
  };
}

const describeIfEngine = engine ? describe : describe.skip;

describeIfEngine('Swift pack golden set (W18-41, local engine)', () => {
  for (const pack of PACKS) {
    const config = path.join(RULEPACKS, pack.file);
    const ids = idsOf(readFileSync(config, 'utf8')).sort();

    it(`${pack.file}: every rule fires on the triggering fixture`, () => {
      const result = runEngine(engine!, config, path.join(FIXTURES, pack.fixtures.trigger));
      // A rule that fails to parse takes itself out of the run silently —
      // zero engine errors is the assertion that notices.
      expect(result.errors).toEqual([]);
      expect([...new Set(result.ruleIds)].sort()).toEqual(ids);
      // One finding per location: a rule reporting the same line twice is
      // two triage decisions for one problem.
      expect(new Set(result.locations).size).toBe(result.locations.length);
    }, 300_000);

    it(`${pack.file}: NOTHING fires on the clean fixture`, () => {
      // The clean fixtures hold the near-misses — Tests/ and main.swift,
      // the Logger-based logging, the guarded trust handler — each a shape a looser
      // version of these rules fired on.
      const result = runEngine(engine!, config, path.join(FIXTURES, pack.fixtures.clean));
      expect(result.errors).toEqual([]);
      expect(result.locations).toEqual([]);
    }, 300_000);
  }
});
