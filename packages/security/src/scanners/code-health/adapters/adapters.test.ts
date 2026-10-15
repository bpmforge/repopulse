import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { biomeAdapter } from './biome.js';
import { ruffAdapter } from './ruff.js';
import { adaptersFor, dedupeAgainstPack, listAdapters, registerAdapter } from './registry.js';
import { extractJson, relativeTo, type ToolAdapter } from './types.js';
import { buildSandboxArgs } from '../../../../sandbox/profile.js';

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
