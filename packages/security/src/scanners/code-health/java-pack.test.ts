import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRulepack, runSemgrepScan } from '../semgrep/scanner.js';

// The Java and Kotlin packs (W18-13, CODE_HEALTH_SUITE.md §9).
//
// Four new pack files, one per scanner directory, each with its own fixtures.
// The fixtures carry their expectations inline — a `// ruleid: <id>` comment
// names the rule that must fire on the NEXT line — so the golden set below is
// exact: a rule that fires one line off, fires twice, or goes silent fails,
// and so does a finding nobody announced.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULEPACKS = path.resolve(HERE, '../../../rulepacks');
const FIXTURES = path.resolve(HERE, '../../../fixtures/java');

const PACKS = [
  { area: 'anti-slop', file: 'code-health/anti-slop.java.v1.yaml', prefix: 'bpm-ch-' },
  { area: 'logging', file: 'code-health/logging.java.v1.yaml', prefix: 'bpm-log-' },
  { area: 'perf', file: 'code-health/perf/perf.java.v1.yaml', prefix: 'bpm-perf-' },
  { area: 'security', file: 'semgrep/bpm-baseline.java.v1.yaml', prefix: 'bpm-' },
] as const;

const packPath = (file: string): string => path.join(RULEPACKS, file);
const packText = (file: string): string => readFileSync(packPath(file), 'utf8');
const ruleIdsOf = (file: string): string[] =>
  [...packText(file).matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]!);

describe('the Java/Kotlin packs are ours and shadowed', () => {
  for (const pack of PACKS) {
    describe(pack.file, () => {
      const text = packText(pack.file);
      const ids = ruleIdsOf(pack.file);

      it('names every rule in our namespace, with a provenance line each', () => {
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(id.startsWith(pack.prefix), id).toBe(true);
        expect((text.match(/provenance: written for RepoPulse/g) ?? []).length).toBe(ids.length);
        // Registry rules are namespaced language.lang.category; one arriving
        // here, even "adapted", is the licence violation (G-18).
        for (const marker of ['java.lang.security', 'kotlin.lang.security', 'semgrep.dev']) {
          expect(text, marker).not.toContain(marker);
        }
      });

      it('ships every rule as a shadow-mode candidate', () => {
        // New rules are guesses about someone else's codebase (§8.2). The
        // line is what rules/shadow.ts reads to keep them out of scores.
        expect((text.match(/^\s+lifecycle: candidate$/gm) ?? []).length).toBe(ids.length);
      });

      it('declares only Java and Kotlin, so the engine routes it by extension', () => {
        // Semgrep picks target files per rule from `languages`; a stray
        // language here would put Java patterns on another language's files.
        const declared = [...text.matchAll(/^\s+languages:\s*\[([^\]]*)\]/gm)];
        expect(declared.length).toBe(ids.length);
        for (const lang of declared.flatMap((m) => m[1]!.split(',').map((l) => l.trim()))) {
          expect(['java', 'kotlin']).toContain(lang);
        }
      });
    });
  }

  it('keeps code-health severities below the security range', () => {
    for (const file of [PACKS[0].file, PACKS[1].file, PACKS[2].file]) {
      expect(packText(file), file).not.toMatch(/severity: (ERROR|CRITICAL)/);
    }
  });

  it('is picked up by the scanners that read each directory', () => {
    // readRulepack is not recursive: the file has to sit directly in the
    // directory the scanner mounts, or it is silently never run.
    expect(readRulepack(path.join(RULEPACKS, 'code-health')).files).toEqual(
      expect.arrayContaining(['anti-slop.java.v1.yaml', 'logging.java.v1.yaml']),
    );
    expect(readRulepack(path.join(RULEPACKS, 'code-health/perf')).files).toContain(
      'perf.java.v1.yaml',
    );
    expect(readRulepack(path.join(RULEPACKS, 'semgrep')).files).toContain(
      'bpm-baseline.java.v1.yaml',
    );
  });
});

// ---- The rules, run by the real engine, in the sandbox ----------------------
//
// Through runSemgrepScan and the scan image, like every other pack's golden
// test: a scan tool spawned on the host is exactly what NFR-14 (arch rule 7)
// forbids, fixtures or not. Without the image these skip; the W18-13 ticket
// note records the same assertions run with a host semgrep 1.181 at authoring
// time.

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

interface EngineResult {
  findings: string[];
  errors: string[];
}

/** Runs the directory a pack lives in, keeping only that pack's findings. */
async function runPack(file: string, target: string): Promise<EngineResult> {
  const own = new Set(ruleIdsOf(file));
  const result = await runSemgrepScan({
    targetDir: target,
    rulepackDir: path.dirname(packPath(file)),
    budget: { wallClockMs: 180_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 },
    ...(scanImage ? { image: scanImage } : {}),
  });
  if (result.status !== 'succeeded') throw new Error(result.error ?? result.status);
  return {
    // The directory also holds the JS packs; their findings are theirs.
    findings: result.findings
      .filter((f) => own.has(f.ruleId))
      .map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`)
      .sort(),
    errors: result.toolErrors,
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The `// ruleid:` announcements in a fixture tree, as `id:file:line`. */
function announced(dir: string): string[] {
  const out: string[] = [];
  for (const file of walk(dir)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = /\/\/\s*ruleid:\s*(bpm-\S+)/.exec(line);
        // index is 0-based; the finding is on the NEXT line, 1-based.
        if (match) out.push(`${match[1]}:${path.relative(dir, file)}:${index + 2}`);
      });
  }
  return out.sort();
}

describe('the fixtures announce every rule', () => {
  // Runs without the engine: a rule with no announced trigger, or an
  // announcement naming a rule that does not exist, is a fixture bug.
  for (const pack of PACKS) {
    it(pack.area, () => {
      const triggering = path.join(FIXTURES, pack.area, 'triggering');
      const named = new Set(announced(triggering).map((a) => a.split(':')[0]));
      expect([...named].sort()).toEqual([...ruleIdsOf(pack.file)].sort());
      expect(announced(path.join(FIXTURES, pack.area, 'clean'))).toEqual([]);
    });
  }
});

describeIfScanImage('golden finding sets (W18-13)', () => {
  for (const pack of PACKS) {
    describe(pack.area, () => {
      const triggering = path.join(FIXTURES, pack.area, 'triggering');
      const clean = path.join(FIXTURES, pack.area, 'clean');

      it('fires exactly where the triggering fixtures say', async () => {
        const result = await runPack(pack.file, triggering);
        // Zero errors is load-bearing: a rule that fails to parse drops out of
        // the run silently and the rest of the pack still "passes".
        expect(result.errors).toEqual([]);
        expect(result.findings).toEqual(announced(triggering));
      }, 300_000);

      it('stays silent on the clean near-misses', async () => {
        const result = await runPack(pack.file, clean);
        expect(result.errors).toEqual([]);
        expect(result.findings).toEqual([]);
      }, 300_000);
    });
  }

  it('routes by extension: a JS-only tree gives these rules nothing', async () => {
    // "Rules run only when the snapshot has Java or Kotlin" holds by
    // construction: each rule's `languages` selects targets by extension. The
    // anti-slop clean fixture also carries a .js file with an empty catch,
    // which the clean test above proves the Java rules never read.
    const jsOnly = path.resolve(HERE, '../../../fixtures/code-health/triggering');
    for (const pack of PACKS) {
      expect((await runPack(pack.file, jsOnly)).findings, pack.file).toEqual([]);
    }
  }, 300_000);
});
