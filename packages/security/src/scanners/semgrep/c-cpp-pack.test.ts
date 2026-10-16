import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseOpengrepOutput } from './output.js';
import { readRulepack } from './scanner.js';

// The C and C++ packs (W18-15): a security baseline loaded by the SAST
// scanner, and anti-slop + logging variants loaded by the code-health ones.
//
// Two halves, like the other pack tests. The static half always runs and
// guards the licence position and the shadow-mode stamp. The engine half runs
// the REAL rule files against their fixtures with whichever engine is on PATH
// (opengrep in the scan image, semgrep on a workstation — the rule format is
// the same), because a rule that fails to parse drops out of a run silently
// and only running it notices.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULEPACKS = path.resolve(HERE, '../../../rulepacks');
const FIXTURES = path.resolve(HERE, '../../../fixtures/c-cpp');

const SECURITY = path.join(RULEPACKS, 'semgrep/bpm-baseline.c-cpp.v1.yaml');
const ANTI_SLOP = path.join(RULEPACKS, 'code-health/anti-slop.c-cpp.v1.yaml');
const LOGGING = path.join(RULEPACKS, 'code-health/logging.c-cpp.v1.yaml');
const PACKS = [SECURITY, ANTI_SLOP, LOGGING];

const SECURITY_RULES = [
  'bpm-c-alloc-unchecked',
  'bpm-c-alloca-variable-size',
  'bpm-c-command-built-string',
  'bpm-c-format-string-variable',
  'bpm-c-gets',
  'bpm-c-memcpy-sizeof-pointer',
  'bpm-c-rand-for-secret',
  'bpm-c-realloc-self-assign',
  'bpm-c-scanf-unbounded-string',
  'bpm-c-sprintf-unbounded',
  'bpm-c-strncpy-unterminated',
  'bpm-c-unbounded-string-copy',
];
const CODE_HEALTH_RULES = [
  'bpm-ch-catch-all-fallback-cpp',
  'bpm-ch-empty-catch-cpp',
  'bpm-ch-stub-fake-success-c',
  'bpm-ch-what-comment-c',
  'bpm-log-c-debug-print',
];

/** Rule ids in one file, by the same line-level read the scanner uses. */
function idsIn(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => /^\s*-?\s*id:\s*(\S+)\s*$/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

describe('the C/C++ packs are ours, and ship in shadow', () => {
  it('carries the expected rules, every one namespaced to us', () => {
    expect(idsIn(SECURITY).sort()).toEqual(SECURITY_RULES);
    expect([...idsIn(ANTI_SLOP), ...idsIn(LOGGING)].sort()).toEqual(CODE_HEALTH_RULES);
    // The logging scanner keeps only bpm-log-* ids; anything else in that
    // file would be loaded and then thrown away.
    for (const id of idsIn(LOGGING)) expect(id.startsWith('bpm-log-'), id).toBe(true);
  });

  it('gives every rule a provenance line and a candidate lifecycle', () => {
    // One per rule, so the claim is checkable file by file. `lifecycle:
    // candidate` is what turns a new rule's findings into shadow findings
    // until a workspace promotes it on evidence (§8.2).
    for (const file of PACKS) {
      const text = readFileSync(file, 'utf8');
      const ids = idsIn(file);
      // Metadata lines only (`^ +key:`) — the headers mention both phrases in prose.
      expect((text.match(/^ +provenance: written for RepoPulse/gm) ?? []).length, file).toBe(
        ids.length,
      );
      expect((text.match(/^ +lifecycle: candidate$/gm) ?? []).length, file).toBe(ids.length);
    }
  });

  it('carries no registry identifiers', () => {
    const text = PACKS.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const marker of ['c.lang.security', 'cpp.lang', 'semgrep.dev', 'p/c', 'r/c.']) {
      expect(text, marker).not.toContain(marker);
    }
  });

  it('records a LIMITATION on every judgement rule', () => {
    const security = readFileSync(SECURITY, 'utf8');
    expect((security.match(/limitation:/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps code health below security severity', () => {
    // A slop rule at ERROR would outrank a real vulnerability in every list
    // sorted by severity.
    for (const file of [ANTI_SLOP, LOGGING]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/severity: (ERROR|CRITICAL)/);
    }
  });

  it('is picked up by the directory reads the scanners do', () => {
    // readRulepack is not recursive: a pack file in the wrong directory would
    // simply never be loaded.
    expect(readRulepack(path.join(RULEPACKS, 'semgrep')).ruleIds).toEqual(
      expect.arrayContaining(SECURITY_RULES),
    );
    expect(readRulepack(path.join(RULEPACKS, 'code-health')).ruleIds).toEqual(
      expect.arrayContaining(CODE_HEALTH_RULES),
    );
  });
});

/**
 * The engine, found on PATH by looking rather than by running it: `semgrep
 * --version` is a Python start-up that took over a minute on a loaded machine,
 * and it ran at collection time, for every test run, whether or not this file
 * was the one being asked about.
 */
const engine = ['opengrep', 'semgrep'].find((bin) =>
  (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
    try {
      accessSync(path.join(dir, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }),
);

const execFileAsync = promisify(execFile);

/**
 * Runs every C/C++ pack over the whole fixture tree ONCE; `ruleId:file:line`.
 *
 * One invocation, partitioned by directory afterwards: the engine's start-up
 * (rule compilation) is most of its cost on files this small, and paying it
 * four times made this the slowest test in the package.
 */
async function scanAll(): Promise<{ hits: string[]; errors: string[] }> {
  // Async, not execFileSync: a worker blocked for minutes cannot answer
  // vitest's RPC heartbeats, and the run fails on a timeout that has nothing
  // to do with the rules.
  const { stdout } = await execFileAsync(
    engine as string,
    [
      ...(engine === 'semgrep' ? ['--metrics=off'] : []),
      ...PACKS.flatMap((p) => ['--config', p]),
      '--json',
      '--quiet',
      FIXTURES,
    ],
    // PYTHONUTF8: the packs' messages contain non-ASCII, and the engine's Python
    // layer dies silently (exit 2, empty stdout) under a bare C locale.
    {
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1', LC_ALL: 'en_US.UTF-8' },
    },
  );
  const parsed = parseOpengrepOutput({
    stdout,
    knownRuleIds: [...SECURITY_RULES, ...CODE_HEALTH_RULES],
    rootDir: FIXTURES,
  });
  if (!parsed.ok) throw new Error('engine output did not parse');
  return {
    hits: parsed.findings.map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`),
    errors: parsed.toolErrors,
  };
}

const rulesOf = (hits: string[]) => [...new Set(hits.map((h) => h.split(':')[0]))].sort();

(engine ? describe : describe.skip)(`C/C++ golden set (${engine ?? 'no engine'})`, () => {
  let run: { hits: string[]; errors: string[] } = { hits: [], errors: [] };
  const under = (dir: string) => run.hits.filter((h) => h.split(':')[1]?.startsWith(`${dir}/`));

  beforeAll(async () => {
    run = await scanAll();
  }, 600_000);

  it('loads every rule: zero rule errors', () => {
    // Load-bearing: a rule that fails to PARSE takes itself out of the run
    // silently, which is how two of these were broken in the first draft (a
    // YAML `#` read as a comment inside a regex, and an `if` pattern the C
    // grammar rejects).
    expect(run.errors).toEqual([]);
  });

  it('every security rule fires on its triggering fixture', () => {
    const hits = under('security/triggering');
    expect(rulesOf(hits)).toEqual(SECURITY_RULES);
    // The C++ spellings of command building and format strings, not only C.
    expect(hits).toEqual(
      expect.arrayContaining([
        'bpm-c-command-built-string:security/triggering/unsafe.cpp:8',
        'bpm-c-command-built-string:security/triggering/unsafe.cpp:12',
        'bpm-c-command-built-string:security/triggering/unsafe.cpp:18',
        'bpm-c-format-string-variable:security/triggering/unsafe.cpp:23',
      ]),
    );
  });

  it('every anti-slop and logging rule fires on its triggering fixture', () => {
    expect(rulesOf(under('code-health/triggering'))).toEqual(CODE_HEALTH_RULES);
  });

  it('NOTHING fires on the clean fixtures', () => {
    // The near-misses: the safe versions of the same jobs, the literal
    // copies, the checked allocations, the typed catch that returns, the
    // early-out with a TODO — each one a false positive some draft produced.
    expect(under('security/clean')).toEqual([]);
    expect(under('code-health/clean')).toEqual([]);
  });
});
