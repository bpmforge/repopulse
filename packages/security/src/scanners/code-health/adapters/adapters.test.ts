import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { biomeAdapter } from './biome.js';
import { cppcheckAdapter } from './cppcheck.js';
import { ruffAdapter } from './ruff.js';
import {
  adaptersFor,
  DEDUP_MAP,
  dedupeAgainstPack,
  listAdapters,
  registerAdapter,
} from './registry.js';
import { extractJson, relativeTo, type ToolAdapter } from './types.js';
import { buildSandboxArgs } from '../../../../sandbox/profile.js';
import { readRulepack } from '../../semgrep/scanner.js';

// Tool adapters (W9-08, CODE_HEALTH_SUITE.md §10, FR-CH-10).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../../fixtures/adapters');

describe('the adapter contract (FR-CH-10)', () => {
  it('adds a tool with ONE file and ONE registry line', () => {
    // The extensibility claim, checked: a fixture adapter participates in
    // routing without a single framework change.
    const fixture: ToolAdapter = {
      key: 'fixture-tool',
      version: '1.0.0',
      license: 'MIT',
      detect: (ctx) => ctx.files.some((f) => f.endsWith('.rb')),
      command: (ctx) => ['fixture-tool', ctx.mountPath],
      parse: () => [],
    };
    registerAdapter(fixture);
    expect(listAdapters().map((a) => a.key)).toContain('fixture-tool');
    expect(
      adaptersFor({ mountPath: '/scan', files: ['a.rb'] }).map((a) => a.key),
    ).toContain('fixture-tool');
  });

  it('THROWS on a duplicate key rather than overwriting', () => {
    // The key is stamped onto every finding, so a duplicate would attribute
    // one tool's output to another.
    expect(() =>
      registerAdapter({ ...ruffAdapter, version: 'other' } as ToolAdapter),
    ).toThrow(/already registered/);
  });

  it('routes by language: Python gets ruff, JS gets Biome, neither gets both', () => {
    // Running Biome over a Python repo costs a container start and produces
    // nothing; running ruff over a JS repo looks like a scanner that is broken.
    const python = adaptersFor({ mountPath: '/scan', files: ['src/app.py'] }).map((a) => a.key);
    const js = adaptersFor({ mountPath: '/scan', files: ['src/app.ts'] }).map((a) => a.key);
    expect(python).toContain('ruff');
    expect(python).not.toContain('biome');
    expect(js).toContain('biome');
    expect(js).not.toContain('ruff');
  });

  it('runs standalone: no network flag, no install step in the argv', () => {
    // The §10 admission filter. A tool that needed `npm install` could not run
    // in a --network=none container at all.
    const argv = ruffAdapter.command({ mountPath: '/scan', files: [] });
    expect(argv.join(' ')).not.toMatch(/install|npm|pip|--fix/);
    // --isolated: a repository's own config must not decide what our scanner
    // reports, or findings stop being comparable between repositories.
    expect(argv).toContain('--isolated');
    // OUR config, baked into the image read-only — not the snapshot's, and not
    // a directory that might have none (Biome refuses to start on that).
    expect(biomeAdapter.command({ mountPath: '/scan', files: [] })).toContain(
      '--config-path=/opt/biome',
    );
  });
});

describe('parsing', () => {
  it('finds JSON after a preamble', () => {
    // Biome prints an "experimental reporter" warning to stdout BEFORE its
    // JSON, so a plain JSON.parse fails on a run that worked perfectly.
    expect(extractJson('warning: experimental\n{"diagnostics":[]}')).toBe('{"diagnostics":[]}');
    expect(extractJson('noise\n[{"code":"E722"}]')).toBe('[{"code":"E722"}]');
    expect(extractJson('   ')).toBeNull();
  });

  it('strips the container mount from a path', () => {
    expect(relativeTo('/scan', '/scan/src/app.py')).toBe('src/app.py');
    expect(relativeTo('/scan', 'src/app.py')).toBe('src/app.py');
  });

  it('keeps only ruff DEFECT rules, not style', () => {
    // A findings list that reports import ordering next to a bare `except`
    // teaches people the list is mostly noise.
    const stdout = JSON.stringify([
      { code: 'E722', message: 'Do not use bare `except`', filename: '/scan/a.py', location: { row: 4 } },
      { code: 'I001', message: 'Import block is un-sorted', filename: '/scan/a.py', location: { row: 1 } },
      { code: 'F401', message: 'unused import', filename: '/scan/a.py', location: { row: 1 } },
    ]);
    const findings = ruffAdapter.parse(stdout, { mountPath: '/scan', files: [] });
    expect(findings.map((f) => f.nativeRule)).toEqual(['E722', 'F401']);
    expect(findings[0]?.ruleId).toBe('tool.ruff.E722');
    expect(findings[0]?.file).toBe('a.py');
  });

  it('keeps only Biome correctness and suspicious groups', () => {
    const stdout = JSON.stringify({
      diagnostics: [
        {
          category: 'lint/correctness/noUnusedVariables',
          message: 'This variable is unused.',
          location: { path: '/scan/a.js', start: { line: 3 } },
        },
        {
          category: 'lint/style/useConst',
          message: 'Use const.',
          location: { path: '/scan/a.js', start: { line: 1 } },
        },
      ],
    });
    const findings = biomeAdapter.parse(stdout, { mountPath: '/scan', files: [] });
    expect(findings.map((f) => f.ruleId)).toEqual(['tool.biome.noUnusedVariables']);
  });

  it('returns NOTHING rather than throwing on unreadable output', () => {
    for (const adapter of [ruffAdapter, biomeAdapter]) {
      expect(adapter.parse('not json', { mountPath: '/scan', files: [] })).toEqual([]);
      expect(adapter.parse('', { mountPath: '/scan', files: [] })).toEqual([]);
    }
  });
});

describe('dedupe against the pack', () => {
  const finding = (nativeRule: string) => ({
    ruleId: `tool.x.${nativeRule}`,
    file: 'a.js',
    lineStart: 1,
    lineEnd: 1,
    severity: 2,
    title: 't',
    message: 'm',
    dimension: 'code_health' as const,
    nativeRule,
  });

  it('drops a tool finding when OUR rule already reports the defect', () => {
    // Ours carries the reasoning about why a swallowed failure matters; the
    // tool says "do not use bare except".
    const { kept, dropped } = dedupeAgainstPack(
      [finding('E722'), finding('F401')],
      ['bpm-ch-empty-catch'],
    );
    expect(kept.map((f) => f.nativeRule)).toEqual(['F401']);
    expect(dropped[0]?.because).toMatch(/already reports this defect/);
  });

  it('keeps the tool finding when the pack rule did NOT fire', () => {
    // Dedup is about duplication, not about preference: with no pack finding
    // there is nothing to duplicate.
    const { kept } = dedupeAgainstPack([finding('E722')], []);
    expect(kept).toHaveLength(1);
  });

  it('KEEPS Biome noExplicitAny beside the suppression-density rate (W18-04)', () => {
    // A rate is not a duplicate of the hits it summarises: dropping the
    // per-line findings would leave a reader a number and nowhere to start.
    const { kept } = dedupeAgainstPack(
      [finding('lint/suspicious/noExplicitAny')],
      ['slop.suppression_density'],
    );
    expect(kept).toHaveLength(1);
  });

  it('matches on RULE identity, not on file and line', () => {
    // Two tools flagging one line for different reasons are two findings, and
    // collapsing by position would silently lose one.
    const { kept } = dedupeAgainstPack([finding('lint/suspicious/noDoubleEquals')], [
      'bpm-ch-empty-catch',
    ]);
    expect(kept).toHaveLength(1);
  });

  it('maps ruff overlaps onto the Python packs, by whichever mapping fired', () => {
    // E722 has two mappings; the Python one alone must be enough to drop it.
    const python = dedupeAgainstPack(
      [finding('E722'), finding('S110'), finding('S307'), finding('S324'), finding('S608')],
      [
        'bpm-ch-bare-except-py',
        'bpm-ch-empty-except-py',
        'bpm-py-eval-dynamic',
        'bpm-py-weak-hash',
        'bpm-py-sql-string-build',
      ],
    );
    expect(python.kept).toEqual([]);
    expect(python.dropped).toHaveLength(5);
  });

  it('keeps a BROADER ruff rule even when the narrower pack rule fired', () => {
    // S311 is every use of `random`; ours is only a secret-named target.
    // Dropping S311 repo-wide because ours fired once would lose the rest.
    const { kept } = dedupeAgainstPack(
      [finding('S311'), finding('S602'), finding('S605')],
      ['bpm-py-random-token', 'bpm-py-subprocess-shell-concat'],
    );
    expect(kept).toHaveLength(3);
  });
});

// The live half.
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

describeIfScanImage('ruff and Biome, actually run in the sandbox', () => {
  const budget = { wallClockMs: 120_000, forgeCalls: 0, llmTokens: 0, memoryMb: 1024 };

  function runAdapter(adapter: ToolAdapter, dir: string): string {
    const ctx = { mountPath: '/scan', files: [] };
    try {
      return execFileSync(
        'podman',
        buildSandboxArgs({
          image: scanImage as string,
          snapshotDir: dir,
          command: adapter.command(ctx),
          budget,
          writablePaths: ['/opt/opengrep/.opengrep'],
        }),
        { stdio: 'pipe' },
      ).toString();
    } catch (err) {
      // Both tools exit non-zero when they find something — that is a
      // successful run, not a failure.
      return (err as { stdout?: Buffer }).stdout?.toString() ?? '';
    }
  }

  it('ruff finds the seeded Python defect with no network', () => {
    const stdout = runAdapter(ruffAdapter, path.join(FIXTURES, 'python'));
    const findings = ruffAdapter.parse(stdout, { mountPath: '/scan', files: [] });
    expect(findings.map((f) => f.nativeRule)).toContain('E722');
    expect(findings[0]?.file).toBe('app.py');
  }, 300_000);

  it('Biome finds the seeded JS defect with no network', () => {
    const stdout = runAdapter(biomeAdapter, path.join(FIXTURES, 'javascript'));
    const findings = biomeAdapter.parse(stdout, { mountPath: '/scan', files: [] });
    expect(findings.map((f) => f.nativeRule).join(' ')).toMatch(/noDoubleEquals|noUnusedVariables/);
  }, 300_000);
});

// cppcheck (W18-15). The parse tests read REAL output: cppcheck 2.22.0, built
// from the pinned source tarball, run with exactly cppcheckAdapter.command()
// over fixtures/adapters/cpp plus fixtures/c-cpp/security/triggering copied
// under a directory standing in for /scan (the only edit to the recording is
// that path prefix, rewritten to /scan).
describe('cppcheck adapter (W18-15)', () => {
  const ctx = { mountPath: '/scan', files: [] };
  const recorded = readFileSync(path.join(FIXTURES, 'cppcheck-2.22.0.xml'), 'utf8');

  it('routes C and C++ to cppcheck, and nothing else', () => {
    for (const file of ['src/a.c', 'src/a.cc', 'lib/a.cpp', 'a.cxx', 'include/a.h', 'a.hpp']) {
      expect(adaptersFor({ mountPath: '/scan', files: [file] }).map((a) => a.key), file).toContain(
        'cppcheck',
      );
    }
    for (const file of ['src/app.py', 'src/app.ts', 'README.md', 'a.cs']) {
      expect(adaptersFor({ mountPath: '/scan', files: [file] }).map((a) => a.key), file).not.toContain(
        'cppcheck',
      );
    }
  });

  it('runs standalone, with OUR settings, and puts the XML on stdout', () => {
    const argv = cppcheckAdapter.command(ctx);
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    const script = argv[2] ?? '';
    // Bounded, and the results printed only when cppcheck FINISHED: a run
    // cut off by the timeout must surface as an empty section (an adapter
    // error), never as a partial list that looks complete.
    expect(script).toMatch(/^rm -f \/tmp\/cppcheck-results\.xml; timeout 480 cppcheck /);
    expect(script).not.toMatch(/install|--project|--inline-suppr|compile_commands|--inconclusive/);
    // cppcheck writes results to stderr by default and the scanner's shell
    // discards stderr; the file-then-cat is the difference between findings
    // and an "adapter produced no output" error on every C repository.
    expect(script).toContain(`'--output-file=/tmp/cppcheck-results.xml'`);
    expect(script).toMatch(/ && cat \/tmp\/cppcheck-results\.xml$/);
    for (const flag of ['--xml', '-q', '--suppress=missingIncludeSystem', '--max-configs=1']) {
      expect(script).toContain(`'${flag}'`);
    }
    expect(script).toContain(`'--enable=warning,portability,performance'`);
    expect(script).toContain(`'/scan'`);
    // GPL: recorded so the licence ledger has something to check against.
    expect(cppcheckAdapter.license).toBe('GPL-3.0-or-later');
  });

  it('quotes the mount path so it cannot be re-parsed by the shell', () => {
    const script = cppcheckAdapter.command({ mountPath: "/odd dir/it's", files: [] })[2] ?? '';
    expect(script).toContain(`'/odd dir/it'\\''s'`);
  });

  it('parses the recorded 2.22.0 run, one finding per <error>', () => {
    const findings = cppcheckAdapter.parse(recorded, ctx);
    expect(findings.map((f) => f.nativeRule).sort()).toEqual([
      'allocaCalled',
      'arrayIndexOutOfBounds',
      'getsCalled',
      'invalidScanfArgType_int',
      'invalidscanf',
      'invalidscanf',
      'literalWithCharPtrCompare',
      'memleak',
      'memleakOnRealloc',
      'nullPointerOutOfMemory',
      'nullPointerOutOfMemory',
      'nullPointerOutOfMemory',
      'pointerSize',
      'pointerSize',
      'uninitvar',
    ]);
    const oob = findings.find((f) => f.nativeRule === 'arrayIndexOutOfBounds');
    expect(oob).toMatchObject({
      ruleId: 'tool.cppcheck.arrayIndexOutOfBounds',
      file: 'app.c',
      lineStart: 8,
      severity: 3,
      dimension: 'correctness',
    });
    // Entities decoded, CWE carried into the message.
    expect(oob?.title).toContain("Array 'values[4]'");
    expect(oob?.message).toContain('(CWE-788)');
  });

  it('reports a multi-location error at its FIRST location, not the trail', () => {
    // nullPointerOutOfMemory lists the dereference and then the allocation;
    // the defect is the dereference.
    const findings = cppcheckAdapter.parse(recorded, ctx).filter(
      (f) => f.nativeRule === 'nullPointerOutOfMemory',
    );
    expect(findings.map((f) => `${f.file}:${f.lineStart}`).sort()).toEqual([
      'security/unsafe.c:67',
      'security/unsafe.c:73',
      'security/unsafe.c:80',
    ]);
  });

  it('drops cppcheck talking about its own run, and classes it did not ask for', () => {
    const xml = `<?xml version="1.0"?><results version="2"><errors>
      <error id="syntaxError" severity="error" msg="syntax error"><location file="/scan/a.c" line="3"/></error>
      <error id="unknownMacro" severity="error" msg="unknown macro"><location file="/scan/a.c" line="4"/></error>
      <error id="checkersReport" severity="information" msg="Active checkers: 100/800"/>
      <error id="constVariable" severity="style" msg="could be const"><location file="/scan/a.c" line="5"/></error>
      <error id="passedByValue" severity="performance" msg="pass by reference"><location file="/scan/b.cpp" line="9"/></error>
    </errors></results>`;
    const findings = cppcheckAdapter.parse(xml, ctx);
    expect(findings.map((f) => f.nativeRule)).toEqual(['passedByValue']);
    expect(findings[0]).toMatchObject({ dimension: 'code_health', file: 'b.cpp', lineStart: 9 });
  });

  it('returns NOTHING rather than throwing on unreadable output', () => {
    for (const stdout of [
      '',
      'not xml',
      '<?xml version="1.0"?><results version="2"><errors>',
      '<error id="x" severity="error" msg="no location and no file0"/>',
      '<results><errors></errors></results>',
    ]) {
      expect(cppcheckAdapter.parse(stdout, ctx), stdout).toEqual([]);
    }
  });

  it('maps only to pack rules that exist, and lets the pack win', () => {
    // A mapping to a renamed or deleted rule would silently stop deduping.
    const cRules = new Set(
      readRulepack(path.resolve(HERE, '../../../../rulepacks/semgrep')).ruleIds,
    );
    const cppcheckRows = DEDUP_MAP.filter((m) => m.packRule.startsWith('bpm-c-'));
    expect(cppcheckRows.length).toBeGreaterThanOrEqual(6);
    for (const row of cppcheckRows) {
      expect(cRules.has(row.packRule), row.packRule).toBe(true);
      expect(row.keep).toBe('pack');
    }
    const findings = cppcheckAdapter.parse(recorded, ctx);
    const { kept, dropped } = dedupeAgainstPack(findings, ['bpm-c-gets', 'bpm-c-alloc-unchecked']);
    expect(dropped.map((d) => d.ruleId).sort()).toEqual([
      'tool.cppcheck.getsCalled',
      'tool.cppcheck.nullPointerOutOfMemory',
      'tool.cppcheck.nullPointerOutOfMemory',
      'tool.cppcheck.nullPointerOutOfMemory',
    ]);
    expect(kept.map((f) => f.nativeRule)).toContain('uninitvar');
  });
});
