import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isVocabularyTerm } from '../chainer/build.js';
import { readRulepack, runSemgrepScan, SEMGREP_RULEPACK_DIR } from './scanner.js';

// Java weak cryptography (W18-49): rulepacks/semgrep/bpm-baseline.java-crypto.v1.yaml.
//
// The fixtures carry their expectations inline — a `ruleid: <id>` comment names
// the rule that must fire on the NEXT line — so the golden set is exact both
// ways, like the injection pack's.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_FILE = 'bpm-baseline.java-crypto.v1.yaml';
const PACK = path.join(SEMGREP_RULEPACK_DIR, PACK_FILE);
const FIXTURES = path.resolve(HERE, '../../../fixtures/java-crypto');

const text = readFileSync(PACK, 'utf8');
const ids = [...text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]!);

const RULES = ['bpm-java-weak-hash', 'bpm-java-weak-cipher', 'bpm-java-weak-random'];

describe('the Java weak-cryptography pack is ours and shadowed', () => {
  it('names every rule in our namespace, with a provenance line each', () => {
    expect([...ids].sort()).toEqual([...RULES].sort());
    expect((text.match(/provenance: written for RepoPulse/g) ?? []).length).toBe(ids.length);
    for (const marker of ['semgrep.dev', 'r2c', 'owasp-benchmark', 'BenchmarkTest']) {
      expect(text, marker).not.toContain(marker);
    }
  });

  it('ships every rule as a shadow-mode candidate', () => {
    expect((text.match(/^\s+lifecycle: candidate$/gm) ?? []).length).toBe(ids.length);
  });

  it('tags every rule with a CWE and an OWASP Top 10 category', () => {
    expect((text.match(/^\s+cwe: .*CWE-\d+/gm) ?? []).length).toBe(ids.length);
    expect((text.match(/^\s+owasp: 'A\d\d:2021 /gm) ?? []).length).toBe(ids.length);
  });

  it('only yields terms the attack chainer knows', () => {
    const yields = [...text.matchAll(/yields: \[([^\]]*)\]/g)].flatMap((m) =>
      m[1]!
        .split(',')
        .map((t) => t.trim().replace(/^'|'$/g, ''))
        .filter(Boolean),
    );
    expect(yields.length).toBeGreaterThan(0);
    for (const term of yields) expect(isVocabularyTerm(term), term).toBe(true);
  });

  it('excludes test files from every rule', () => {
    expect((text.match(/^\s+exclude:$/gm) ?? []).length).toBe(ids.length);
  });

  it('uses no YAML anchors or aliases', () => {
    expect(text).not.toMatch(/:\s*&[\w-]+\s*$/m);
    expect(text).not.toMatch(/:\s*\*[\w-]+\s*$/m);
  });

  it('is picked up by the SAST scanner, which reads the directory', () => {
    const pack = readRulepack();
    expect(pack.files).toContain(PACK_FILE);
    expect(pack.ruleIds).toEqual(expect.arrayContaining(RULES));
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The `ruleid:` announcements in a fixture tree, as `id:file:line`. */
function announced(dir: string): string[] {
  const out: string[] = [];
  for (const file of walk(dir)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = /\/\/\s*ruleid:\s*(bpm-\S+)/.exec(line);
        if (match) out.push(`${match[1]}:${path.relative(dir, file)}:${index + 2}`);
      });
  }
  return out.sort();
}

describe('the fixtures announce every rule', () => {
  // Runs without the engine: a rule with no announced trigger, or an
  // announcement naming a rule that does not exist, is a fixture bug.
  it('every rule has a trigger, and the clean tree announces nothing', () => {
    const named = new Set(announced(path.join(FIXTURES, 'triggering')).map((a) => a.split(':')[0]));
    expect([...named].sort()).toEqual([...RULES].sort());
    expect(announced(path.join(FIXTURES, 'clean'))).toEqual([]);
  });
});

// ---- The rules, run by the real engine, in the sandbox ----------------------
//
// Through runSemgrepScan and the scan image, like every other pack's golden
// test. Without the image these skip.

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

async function runPack(target: string): Promise<{ findings: string[]; errors: string[] }> {
  const own = new Set(ids);
  const result = await runSemgrepScan({
    targetDir: target,
    budget: { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 },
    ...(scanImage ? { image: scanImage } : {}),
  });
  if (result.status !== 'succeeded') throw new Error(result.error ?? result.status);
  return {
    // The directory also holds the other packs; their findings are their own.
    findings: result.findings
      .filter((f) => own.has(f.ruleId))
      .map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`)
      .sort(),
    errors: result.toolErrors,
  };
}

describeIfScanImage('Java weak-cryptography golden sets (W18-49)', () => {
  it('fires exactly where the triggering fixtures say', async () => {
    const triggering = path.join(FIXTURES, 'triggering');
    const result = await runPack(triggering);
    // Zero errors is load-bearing: a rule that fails to parse drops out of the
    // run silently and the rest of the pack still "passes".
    expect(result.errors).toEqual([]);
    expect(result.findings).toEqual(announced(triggering));
  }, 300_000);

  it('stays silent on the clean near-misses', async () => {
    const result = await runPack(path.join(FIXTURES, 'clean'));
    expect(result.errors).toEqual([]);
    expect(result.findings).toEqual([]);
  }, 300_000);
});
