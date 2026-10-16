import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRulepack } from './scanner.js';

// The C and C++ dataflow pack (W18-44), beside the W18-15 shape pack.
//
// Fixtures announce their findings: `// ruleid: <id>` names the rule that must
// fire on the NEXT line. The static half runs anywhere. The live half runs the
// rules with a LOCAL semgrep/opengrep binary when one is on PATH (measured on
// semgrep 1.181) and asserts the findings are EXACTLY the announced ones.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.resolve(HERE, '../../../rulepacks/semgrep/bpm-baseline.c-cpp-flow.v1.yaml');
const FIXTURES = path.resolve(HERE, '../../../fixtures/c-cpp/flow');

const text = readFileSync(PACK, 'utf8');

/** The weakness classes this pack claims. C++ file streams (`std::ifstream`) are not claimed: the engine does not report them as taint sinks. */
const CLAIMED = ['cmd', 'path', 'format', 'copy', 'size'];

const ids = [...text.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);

describe('the C and C++ dataflow pack is ours, shadowed and taint-mode', () => {
  it('names every rule in our namespace, with a provenance line each', () => {
    for (const id of ids) expect(id.startsWith('bpm-flow-') && id.endsWith('-c'), id).toBe(true);
    expect((text.match(/provenance: written for RepoPulse/g) ?? []).length).toBe(ids.length);
  });

  it('ships every rule as a shadow-mode candidate', () => {
    expect((text.match(/lifecycle: candidate/g) ?? []).length).toBe(ids.length);
  });

  it('is taint mode for every rule, because an injection is a flow', () => {
    expect((text.match(/^ {4}mode: taint$/gm) ?? []).length).toBe(ids.length);
  });

  it('tags every rule with a CWE and an OWASP Top 10 category', () => {
    expect((text.match(/cwe: 'CWE-\d+: /g) ?? []).length).toBe(ids.length);
    expect((text.match(/owasp: 'A\d\d:2021 /g) ?? []).length).toBe(ids.length);
  });

  it('covers exactly the weakness classes it claims', () => {
    expect(ids.map((id) => id.split('-')[2]).sort()).toEqual([...CLAIMED].sort());
  });

  it('is declared for both C and C++', () => {
    expect((text.match(/languages: \[c, cpp\]/g) ?? []).length).toBe(ids.length);
  });

  it('excludes test files from every rule', () => {
    expect((text.match(/^ {4}paths:\n {6}exclude:/gm) ?? []).length).toBe(ids.length);
  });

  it('uses no YAML anchors or aliases', () => {
    expect(text).not.toMatch(/^\s*[^#\n]*[&*][A-Za-z_]+\s*$/m);
  });

  it('carries no registry identifiers', () => {
    for (const marker of ['semgrep.dev', 'p/c', 'p/cpp', '--config auto']) {
      expect(text, marker).not.toContain(marker);
    }
  });

  it('is picked up by the directory loader the SAST scanner uses', () => {
    expect(readRulepack(path.dirname(PACK)).files).toContain(path.basename(PACK));
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function announced(dir: string): string[] {
  const out: string[] = [];
  for (const file of walk(dir)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = /(?:\/\/|\/\*)\s*ruleid:\s*(bpm-\S+)/.exec(line);
        if (match) out.push(`${match[1]}:${path.relative(dir, file)}:${index + 2}`);
      });
  }
  return out.sort();
}

describe('the fixtures announce every rule', () => {
  it('every rule has a trigger, and the clean tree announces nothing', () => {
    const named = new Set(announced(path.join(FIXTURES, 'triggering')).map((a) => a.split(':')[0]));
    expect([...named].sort()).toEqual([...ids].sort());
    expect(announced(path.join(FIXTURES, 'clean'))).toEqual([]);
  });
});

// ---- Live: the real engine over the fixtures ------------------------------

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

function runEngine(bin: string, target: string): { found: string[]; errors: string[] } {
  const args = [
    ...(bin === 'semgrep' ? ['--metrics=off'] : []),
    '--config',
    PACK,
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
    // Opengrep repeats taint matches; one finding per rule and line is the claim.
    found: [
      ...new Set(
        parsed.results.map(
          (r) => `${r.check_id.split('.').pop()}:${path.relative(target, r.path)}:${r.start.line}`,
        ),
      ),
    ].sort(),
    errors: parsed.errors.map((e) => e.message ?? JSON.stringify(e.type)),
  };
}

const describeIfEngine = engine ? describe : describe.skip;

describeIfEngine('C and C++ dataflow golden set (W18-44, local engine)', () => {
  it('fires exactly where the triggering fixtures say', () => {
    const dir = path.join(FIXTURES, 'triggering');
    const result = runEngine(engine!, dir);
    expect(result.errors).toEqual([]);
    expect(result.found).toEqual(announced(dir));
  }, 300_000);

  it('stays silent on the clean near-misses', () => {
    const result = runEngine(engine!, path.join(FIXTURES, 'clean'));
    expect(result.errors).toEqual([]);
    expect(result.found).toEqual([]);
  }, 300_000);
});
