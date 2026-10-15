import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRulepack, runSemgrepScan, SEMGREP_RULEPACK_DIR } from './scanner.js';

// Model output used without validation (W18-09, R-28): the taint pack in
// rulepacks/semgrep/bpm-baseline.llm-output.v1.yaml.
//
// The fixtures carry their expectations inline — a `ruleid: <id>` comment
// names the rule that must fire on the NEXT line — so the golden set is exact
// both ways: a rule that fires one line off, twice, or not at all fails, and
// so does a finding nobody announced.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_FILE = 'bpm-baseline.llm-output.v1.yaml';
const PACK = path.join(SEMGREP_RULEPACK_DIR, PACK_FILE);
const FIXTURES = path.resolve(HERE, '../../../fixtures/llm-output');

const text = readFileSync(PACK, 'utf8');
const ids = [...text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]!);

const RULES = [
  'bpm-llm-output-exec',
  'bpm-llm-output-injection',
  'bpm-llm-output-json-unvalidated',
  'bpm-llm-output-exec-py',
  'bpm-llm-output-injection-py',
  'bpm-llm-output-json-unvalidated-py',
  'bpm-llm-output-jinja-safe',
];

describe('the LLM-output pack is ours and shadowed', () => {
  it('names every rule in our namespace, with a provenance line each', () => {
    expect([...ids].sort()).toEqual([...RULES].sort());
    expect((text.match(/provenance: written for RepoPulse/g) ?? []).length).toBe(ids.length);
    // Registry rules are namespaced language.lang.category; one arriving here,
    // even "adapted", is the licence violation (G-18).
    for (const marker of ['javascript.lang.', 'python.lang.', 'semgrep.dev', 'r2c']) {
      expect(text, marker).not.toContain(marker);
    }
  });

  it('ships every rule as a shadow-mode candidate', () => {
    // §8.2: a new rule is a guess about someone else's codebase. The line is
    // what rules/shadow.ts reads to keep its findings out of scores.
    expect((text.match(/^\s+lifecycle: candidate$/gm) ?? []).length).toBe(ids.length);
  });

  it('is taint mode for every rule that follows a flow', () => {
    // Six of the seven follow model output to a sink; only the Jinja rule,
    // which reads a template no dataflow can reach, is a pattern.
    expect((text.match(/^\s+mode: taint$/gm) ?? []).length).toBe(ids.length - 1);
  });

  it('uses no YAML anchors or aliases', () => {
    // The shared source lists are written out per rule on purpose: how a
    // given engine build resolves aliases is not something to depend on.
    expect(text).not.toMatch(/:\s*&[\w-]+\s*$/m);
    expect(text).not.toMatch(/:\s*\*[\w-]+\s*$/m);
  });

  it('excludes test files from every taint rule', () => {
    // A mocked completion fed to JSON.parse in a test is the test working.
    expect((text.match(/^\s+exclude:$/gm) ?? []).length).toBe(ids.length - 1);
  });

  it('is picked up by the SAST scanner, which reads the directory', () => {
    // readRulepack is not recursive: the file has to sit directly in the
    // directory the scanner mounts, or it is silently never run.
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
        const match = /(?:\/\/|#)\s*ruleid:\s*(bpm-\S+)/.exec(line);
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

  it('covers both languages and every sink family', () => {
    const all = announced(path.join(FIXTURES, 'triggering')).join('\n');
    for (const file of ['agent.ts', 'Answer.tsx', 'agent.py', 'templates/answer.html']) {
      expect(all, file).toContain(`:${file}:`);
    }
  });
});

// ---- The rules, run by the real engine, in the sandbox ----------------------
//
// Through runSemgrepScan and the scan image, like every other pack's golden
// test: a scan tool spawned on the host is what NFR-14 forbids, fixtures or
// not. Without the image these skip; the W18-09 ticket note records the same
// golden sets run with a host semgrep 1.181 at authoring time.

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
    // The directory also holds the baseline pack; its findings are its own
    // (eval of model output is also an eval).
    findings: result.findings
      .filter((f) => own.has(f.ruleId))
      .map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`)
      .sort(),
    errors: result.toolErrors,
  };
}

describeIfScanImage('LLM-output golden sets (W18-09)', () => {
  it('fires exactly where the triggering fixtures say', async () => {
    const triggering = path.join(FIXTURES, 'triggering');
    const result = await runPack(triggering);
    // Zero errors is load-bearing: a rule that fails to parse drops out of
    // the run silently and the rest of the pack still "passes".
    expect(result.errors).toEqual([]);
    expect(result.findings).toEqual(announced(triggering));
  }, 300_000);

  it('stays silent on the clean near-misses', async () => {
    const result = await runPack(path.join(FIXTURES, 'clean'));
    expect(result.errors).toEqual([]);
    expect(result.findings).toEqual([]);
  }, 300_000);
});
