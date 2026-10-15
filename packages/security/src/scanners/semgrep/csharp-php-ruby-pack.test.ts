import { execFile } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseOpengrepOutput } from './output.js';
import { readRulepack } from './scanner.js';

// The C#, PHP and Ruby packs (W18-16, CODE_HEALTH_SUITE.md §9): per language, a
// security baseline loaded by the SAST scanner and anti-slop + logging variants
// loaded by the code-health ones — nine files.
//
// Two halves, like the other pack tests. The static half always runs and
// guards the licence position, the shadow-mode stamp and language routing. The
// engine half runs the REAL rule files against their fixtures with whichever
// engine is on PATH (opengrep in the scan image, semgrep on a workstation —
// the rule format is the same), because a rule that fails to parse drops out
// of a run silently and only running it notices.
//
// The fixtures carry their expectations inline: a `ruleid: <id>` comment names
// the rule that must fire on the NEXT line, so the golden set is exact — a
// rule that fires a line off, fires twice, or goes silent fails, and so does a
// finding nobody announced.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULEPACKS = path.resolve(HERE, '../../../rulepacks');
const FIXTURES = path.resolve(HERE, '../../../fixtures');

interface Language {
  name: 'csharp' | 'php' | 'ruby';
  /** The rule-file language tag; the only one these packs may declare. */
  engineLanguage: string;
  /** Rule-id stem: security ids are `bpm-<stem>-…`, code health `bpm-ch-<stem>-…`. */
  stem: string;
}

const LANGUAGES: readonly Language[] = [
  { name: 'csharp', engineLanguage: 'csharp', stem: 'cs' },
  { name: 'php', engineLanguage: 'php', stem: 'php' },
  { name: 'ruby', engineLanguage: 'ruby', stem: 'rb' },
];

const securityPack = (lang: Language): string =>
  path.join(RULEPACKS, `semgrep/bpm-baseline.${lang.name}.v1.yaml`);
const antiSlopPack = (lang: Language): string =>
  path.join(RULEPACKS, `code-health/anti-slop.${lang.name}.v1.yaml`);
const loggingPack = (lang: Language): string =>
  path.join(RULEPACKS, `code-health/logging.${lang.name}.v1.yaml`);
const packsOf = (lang: Language): string[] => [
  securityPack(lang),
  antiSlopPack(lang),
  loggingPack(lang),
];
const ALL_PACKS = LANGUAGES.flatMap(packsOf);

/** Rule ids in one file, by the same line-level read the scanner uses. */
function idsIn(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The `ruleid:` announcements under a directory, as `id:path-from-FIXTURES:line`. */
function announced(dir: string): string[] {
  const out: string[] = [];
  for (const file of walk(dir)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = /(?:\/\/|#)\s*ruleid:\s*(bpm-\S+)/.exec(line);
        // index is 0-based; the finding is on the NEXT line, 1-based.
        if (match) out.push(`${match[1]}:${path.relative(FIXTURES, file)}:${index + 2}`);
      });
  }
  return out.sort();
}

const idOf = (hit: string): string => hit.split(':')[0]!;

describe('the C#, PHP and Ruby packs are ours, and ship in shadow', () => {
  for (const lang of LANGUAGES) {
    describe(lang.name, () => {
      it('names every rule in our namespace, per language', () => {
        for (const id of idsIn(securityPack(lang))) {
          expect(id.startsWith(`bpm-${lang.stem}-`), id).toBe(true);
        }
        for (const id of idsIn(antiSlopPack(lang))) {
          expect(id.startsWith(`bpm-ch-${lang.stem}-`), id).toBe(true);
        }
        // The logging scanner keeps only bpm-log-* ids; anything else in that
        // file would be loaded and then thrown away.
        for (const id of idsIn(loggingPack(lang))) {
          expect(id.startsWith(`bpm-log-${lang.stem}-`), id).toBe(true);
        }
      });

      it('gives every rule a provenance line and a candidate lifecycle', () => {
        // One per rule, so the claim is checkable file by file. `lifecycle:
        // candidate` is what rules/shadow.ts reads to keep a new rule's
        // findings out of scores until a workspace promotes it (§8.2).
        for (const file of packsOf(lang)) {
          const text = readFileSync(file, 'utf8');
          const ids = idsIn(file);
          expect(ids.length, file).toBeGreaterThan(0);
          // Metadata lines only (`^ +key:`) — the headers mention both in prose.
          expect((text.match(/^ +provenance: written for RepoPulse/gm) ?? []).length, file).toBe(
            ids.length,
          );
          expect((text.match(/^ +lifecycle: candidate$/gm) ?? []).length, file).toBe(ids.length);
        }
      });

      it('declares only its own language, so the engine routes it by extension', () => {
        // Semgrep picks target files per rule from `languages`; a stray
        // language here would put PHP patterns on another language's files.
        for (const file of packsOf(lang)) {
          const text = readFileSync(file, 'utf8');
          const declared = [...text.matchAll(/^\s+languages:\s*\[([^\]]*)\]/gm)];
          expect(declared.length, file).toBe(idsIn(file).length);
          for (const tag of declared.flatMap((m) => m[1]!.split(',').map((l) => l.trim()))) {
            expect(tag, file).toBe(lang.engineLanguage);
          }
        }
      });

      it('announces every rule in the triggering fixtures and none in the clean ones', () => {
        // Runs without the engine: a rule with no announced trigger, or an
        // announcement naming a rule that does not exist, is a fixture bug.
        const security = new Set(
          announced(path.join(FIXTURES, lang.name, 'security/triggering')).map(idOf),
        );
        expect([...security].sort()).toEqual(idsIn(securityPack(lang)).sort());
        const health = new Set(
          announced(path.join(FIXTURES, lang.name, 'code-health/triggering')).map(idOf),
        );
        expect([...health].sort()).toEqual(
          [...idsIn(antiSlopPack(lang)), ...idsIn(loggingPack(lang))].sort(),
        );
        expect(announced(path.join(FIXTURES, lang.name, 'security/clean'))).toEqual([]);
        expect(announced(path.join(FIXTURES, lang.name, 'code-health/clean'))).toEqual([]);
      });
    });
  }

  it('carries no registry identifiers', () => {
    const text = ALL_PACKS.map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const marker of [
      'csharp.lang.security',
      'csharp.dotnet',
      'php.lang.security',
      'php.laravel',
      'ruby.lang.security',
      'ruby.rails.security',
      'semgrep.dev',
      'p/php',
      'p/ruby',
      'p/csharp',
    ]) {
      expect(text, marker).not.toContain(marker);
    }
  });

  it('records a LIMITATION on judgement rules', () => {
    for (const lang of LANGUAGES) {
      const text = readFileSync(securityPack(lang), 'utf8');
      expect((text.match(/limitation:/g) ?? []).length, lang.name).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps code health below security severity', () => {
    // A slop rule at ERROR would outrank a real vulnerability in every list
    // sorted by severity.
    for (const lang of LANGUAGES) {
      for (const file of [antiSlopPack(lang), loggingPack(lang)]) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(/severity: (ERROR|CRITICAL)/);
      }
    }
  });

  it('is picked up by the directory reads the scanners do', () => {
    // readRulepack is not recursive: a pack file in the wrong directory would
    // simply never be loaded.
    const semgrepDir = readRulepack(path.join(RULEPACKS, 'semgrep')).files;
    const healthDir = readRulepack(path.join(RULEPACKS, 'code-health')).files;
    for (const lang of LANGUAGES) {
      expect(semgrepDir).toContain(`bpm-baseline.${lang.name}.v1.yaml`);
      expect(healthDir).toEqual(
        expect.arrayContaining([`anti-slop.${lang.name}.v1.yaml`, `logging.${lang.name}.v1.yaml`]),
      );
    }
  });
});

/**
 * The engine, found on PATH by looking rather than by running it: `semgrep
 * --version` is a Python start-up that can take a minute on a loaded machine,
 * and it would run at collection time for every test run.
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
 * Runs all nine packs over the three language trees AND the JS code-health
 * fixtures, once; `ruleId:path-from-FIXTURES:line`.
 *
 * One invocation, partitioned afterwards: the engine's start-up (rule
 * compilation) is most of its cost on files this small. The JS tree is there
 * to prove routing: these packs must find nothing in a tree of another
 * language, however slop-shaped it is.
 */
async function scanAll(): Promise<{ hits: string[]; errors: string[] }> {
  // Async, not execFileSync: a worker blocked for minutes cannot answer
  // vitest's RPC heartbeats.
  const { stdout } = await execFileAsync(
    engine as string,
    [
      ...(engine === 'semgrep' ? ['--metrics=off'] : []),
      ...ALL_PACKS.flatMap((p) => ['--config', p]),
      '--json',
      '--quiet',
      ...LANGUAGES.map((l) => path.join(FIXTURES, l.name)),
      path.join(FIXTURES, 'code-health'),
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const parsed = parseOpengrepOutput({
    stdout,
    knownRuleIds: ALL_PACKS.flatMap(idsIn),
    rootDir: FIXTURES,
  });
  if (!parsed.ok) throw new Error(`engine output did not parse: ${parsed.error}`);
  return {
    hits: parsed.findings.map((f) => `${f.ruleId}:${f.file}:${f.lineStart}`).sort(),
    errors: parsed.toolErrors,
  };
}

(engine ? describe : describe.skip)(`C#/PHP/Ruby golden set (${engine ?? 'no engine'})`, () => {
  let run: { hits: string[]; errors: string[] } = { hits: [], errors: [] };
  const under = (dir: string): string[] =>
    run.hits.filter((h) => h.split(':')[1]?.startsWith(`${dir}/`));

  beforeAll(async () => {
    run = await scanAll();
  }, 600_000);

  it('loads every rule: zero rule errors', () => {
    // Load-bearing: a rule that fails to PARSE takes itself out of the run
    // silently. Two drafts of these were broken that way (a Ruby pattern with
    // an unquoted `key: value`, a C# pattern with `, ...` in a base list).
    expect(run.errors).toEqual([]);
  });

  for (const lang of LANGUAGES) {
    for (const area of ['security', 'code-health']) {
      it(`${lang.name} ${area}: fires exactly where the triggering fixtures say`, () => {
        expect(under(`${lang.name}/${area}/triggering`)).toEqual(
          announced(path.join(FIXTURES, lang.name, area, 'triggering')),
        );
      });

      it(`${lang.name} ${area}: stays silent on the clean near-misses`, () => {
        expect(under(`${lang.name}/${area}/clean`)).toEqual([]);
      });
    }
  }

  it('routes by language: the JS fixtures give these rules nothing', () => {
    expect(under('code-health')).toEqual([]);
  });
});
