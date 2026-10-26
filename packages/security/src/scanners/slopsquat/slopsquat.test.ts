import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectTree, privateScopesOf } from './collect.js';
import { detectSlopsquats, NEAR_MISS_RULE, SLOPSQUAT_RULE } from './detect.js';
import { addedFileText, addedLineNumbers } from './diff.js';
import { slopFinding } from './findings.js';
import { readDeclarations, readResolved } from './manifests.js';
import { normalizePackageName } from './names.js';
import { loadPopular, parsePopular } from './popular.js';
import { indexFromLines, loadPackageIndex, type PackageIndex } from './registry-index.js';
import { nearMiss, osaDistance } from './similarity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILDER = path.resolve(HERE, '../../../../../deploy/build-package-index.py');
const NOW = new Date('2026-10-26T00:00:00Z');
const popular = loadPopular();

const indexOf = (ecosystems: PackageIndex['ecosystems']): PackageIndex => ({
  dir: 'test',
  generated: '2026-10-26',
  ecosystems,
  missing: {},
});

describe('names (W21-05)', () => {
  it('normalises the way each registry does', () => {
    expect(normalizePackageName('pypi', 'Python_Dateutil')).toBe('python-dateutil');
    expect(normalizePackageName('pypi', 'zope.interface')).toBe('zope-interface');
    expect(normalizePackageName('cargo', 'rust_decimal')).toBe('rust-decimal');
    expect(normalizePackageName('npm', 'JSONStream')).toBe('jsonstream');
    expect(normalizePackageName('go', 'github.com/BurntSushi/toml')).toBe(
      'github.com/BurntSushi/toml',
    );
  });

  it('the index builder applies the same rules and sorts by UTF-8 bytes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pkgidx-'));
    const src = path.join(dir, 'pypi.txt');
    writeFileSync(src, 'Python_Dateutil\nzope.interface\nRequests\nrequests\n');
    const cargo = path.join(dir, 'cargo.txt');
    writeFileSync(cargo, 'rust_decimal\t2016-01-01T00:00:00Z\t5000000\nAbc\n');
    execFileSync('python3', ['-I', BUILDER, dir, `pypi=${src}`, `cargo=${cargo}`], {
      env: { ...process.env, SCAN_PACKAGE_INDEX_ECOSYSTEMS: '' },
    });
    expect(readFileSync(path.join(dir, 'pypi.tsv'), 'utf8')).toBe(
      'python-dateutil\nrequests\nzope-interface\n',
    );
    const index = loadPackageIndex(dir);
    expect(index.ecosystems.pypi!.has('python_dateutil')).toBe(true);
    expect(index.ecosystems.pypi!.has('dateutil')).toBe(false);
    expect(index.ecosystems.cargo!.metadata).toBe(true);
    expect(index.ecosystems.cargo!.meta('rust-decimal')).toEqual({
      created: '2016-01-01T00:00:00Z',
      downloads: 5000000,
    });
    expect(index.missing.npm).toMatch(/no npm list/);
  });
});

describe('package index (W21-05)', () => {
  const npm = indexFromLines('npm', ['zod', '@babel/core', 'react', 'lodash', '@types/node', 'a']);

  it('answers membership and scope prefixes by binary search', () => {
    for (const n of ['zod', '@babel/core', 'react', 'lodash', '@types/node', 'a'])
      expect(npm.has(n)).toBe(true);
    expect(npm.has('reac')).toBe(false);
    expect(npm.has('reactt')).toBe(false);
    expect(npm.hasPrefix('@babel/')).toBe(true);
    expect(npm.hasPrefix('@acme/')).toBe(false);
  });

  it('reads an absent index as "not checked" for every ecosystem, never as empty', () => {
    const index = loadPackageIndex(path.join(tmpdir(), 'definitely-not-here'));
    expect(Object.keys(index.ecosystems)).toEqual([]);
    expect(index.missing.npm).toMatch(/run deploy\/scan-db-sync\.sh/);
  });

  it('refuses a Go list whose backfill has not completed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pkgidx-go-'));
    writeFileSync(path.join(dir, 'go.tsv'), 'github.com/a/b\n');
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        ecosystems: { go: { file: 'go.tsv', complete: false, generated: '2026-10-26' } },
      }),
    );
    const index = loadPackageIndex(dir);
    expect(index.ecosystems.go).toBeUndefined();
    expect(index.missing.go).toMatch(/still backfilling/);
  });
});

describe('near-miss patterns (W21-05)', () => {
  it('measures optimal string alignment distance', () => {
    expect(osaDistance('colorama', 'colourama')).toBe(1);
    expect(osaDistance('lodash', 'loadsh')).toBe(1); // adjacent swap
    expect(osaDistance('abc', 'xyz123', 2)).toBe(3);
  });

  it.each([
    ['pypi', 'jeIlyfish', 'jellyfish', 'homoglyph'],
    ['npm', 'crossenv', 'cross-env', 'separator'],
    ['cargo', 'rustdecimal', 'rust-decimal', 'separator'],
    ['pypi', 'python3-dateutil', 'python-dateutil', 'affix'],
    ['pypi', 'colourama', 'colorama', 'edit'],
    ['go', 'github.com/boltdb-go/bolt', 'github.com/boltdb/bolt', 'owner'],
  ] as const)('%s %s imitates %s (%s)', (eco, name, target, pattern) => {
    expect(nearMiss(eco, name, popular[eco])).toMatchObject({ target, pattern });
  });

  it('never calls a popular package, a versioned sibling or a family member a typo', () => {
    expect(nearMiss('npm', 'request', popular.npm)).toBeNull(); // popular itself
    expect(String(nearMiss('npm', '@aws-sdk/client-sesv9', popular.npm)?.target)).not.toMatch(
      /^@aws-sdk/,
    );
    expect(nearMiss('go', 'github.com/go-chi/chi/v4', popular.go)).toBeNull();
    expect(nearMiss('pypi', 'mypy-boto3-emr', popular.pypi)).toBeNull();
    expect(nearMiss('npm', 'vue2', parsePopular('npm', 'vue\nvue3\n'))).toBeNull();
  });
});

describe('manifest readers keep the line (W21-05)', () => {
  it('package.json: every dependency table, aliases resolved, non-registry specs skipped', () => {
    const text = JSON.stringify(
      {
        name: 'app',
        dependencies: {
          react: '^18',
          alias: 'npm:lodash-es@^4',
          local: 'file:../x',
          gh: 'user/repo#v1',
        },
        devDependencies: { vitest: '^2' },
        peerDependencies: { 'react-dom': '*' },
      },
      null,
      2,
    );
    const read = readDeclarations('web/package.json', text)!;
    expect(read.ownName).toBe('app');
    expect(read.declarations.map((d) => [d.name, d.line, d.section])).toEqual([
      ['react', 4, 'dependencies'],
      ['lodash-es', 5, 'dependencies'],
      ['vitest', 10, 'devDependencies'],
      ['react-dom', 13, 'peerDependencies'],
    ]);
    expect(readDeclarations('bad/package.json', '{nope')!.unparsed).toBe(true);
  });

  it('requirements: options, URLs, paths and editable installs are not packages; a private index is noted', () => {
    const read = readDeclarations(
      'requirements.txt',
      [
        '--extra-index-url https://pypi.acme.internal/simple',
        'flask>=3 ; python_version>"3.8"',
        '-e .',
        'x @ https://e.com/x.whl',
        'git+https://g/x.git',
        'Django[bcrypt]==5.1  # web',
      ].join('\n'),
    )!;
    expect(read.privateIndex).toBe(true);
    expect(read.declarations.map((d) => [d.name, d.line])).toEqual([
      ['flask', 2],
      ['Django', 6],
    ]);
  });

  it('pyproject, Pipfile, setup.cfg', () => {
    const py = readDeclarations(
      'pyproject.toml',
      '[project]\ndependencies = [\n  "numpy>=1",\n  "httpx",\n]\n[tool.poetry.dependencies]\npython = "^3.12"\nrich = "^13"\nlocal = { path = "../l" }\n',
    )!;
    expect(py.declarations.map((d) => [d.name, d.line])).toEqual([
      ['numpy', 3],
      ['httpx', 4],
      ['rich', 8],
    ]);
    const pipfile = readDeclarations(
      'Pipfile',
      '[[source]]\nurl = "https://pypi.org/simple"\n[packages]\nrequests = "*"\n',
    )!;
    expect(pipfile.privateIndex).toBe(false);
    expect(pipfile.declarations.map((d) => d.name)).toEqual(['requests']);
    const cfg = readDeclarations(
      'setup.cfg',
      '[options]\ninstall_requires =\n    click>=8\n    attrs\nzip_safe = False\n',
    )!;
    expect(cfg.declarations.map((d) => [d.name, d.line])).toEqual([
      ['click', 3],
      ['attrs', 4],
    ]);
  });

  it('go.mod, Cargo.toml, Gemfile, pom.xml, build.gradle', () => {
    const go = readDeclarations(
      'go.mod',
      'module m\n\nrequire github.com/a/b v1.0.0\nrequire (\n\tgithub.com/c/d v0.1.0 // indirect\n\tlocalmod v0.0.0\n\texample.com/r v1.0.0\n)\nreplace example.com/r => ./r\n',
    )!;
    expect(go.declarations.map((d) => [d.name, d.line])).toEqual([
      ['github.com/a/b', 3],
      ['github.com/c/d', 5],
    ]);
    const cargo = readDeclarations(
      'Cargo.toml',
      '[dependencies]\nserde = "1"\nmine = { path = "../m" }\nfoo = { package = "bar", version = "1" }\n\n[dev-dependencies.criterion]\nversion = "0.5"\n\n[dependencies.ws]\nworkspace = true\n',
    )!;
    expect(cargo.declarations.map((d) => [d.name, d.line]).sort()).toEqual([
      ['bar', 4],
      ['criterion', 6],
      ['serde', 2],
    ]);
    const gem = readDeclarations(
      'Gemfile',
      'source "https://rubygems.org"\ngem "rails"\nsource "https://gems.acme.internal" do\n  gem "acme-auth"\nend\ngem "x", path: "vendor/x"\ngem "puma"\n',
    )!;
    expect(gem.declarations.map((d) => [d.name, d.line])).toEqual([
      ['rails', 2],
      ['puma', 7],
    ]);
    const pom = readDeclarations(
      'pom.xml',
      '<project>\n<dependencies>\n<dependency>\n  <groupId>junit</groupId>\n  <artifactId>junit</artifactId>\n</dependency>\n<dependency><groupId>${g}</groupId><artifactId>x</artifactId></dependency>\n</dependencies>\n</project>\n',
    )!;
    expect(pom.declarations.map((d) => [d.name, d.line])).toEqual([['junit:junit', 5]]);
    const gradle = readDeclarations(
      'build.gradle',
      "dependencies {\n  implementation 'com.squareup.okhttp3:okhttp:4.12.0'\n}\n",
    )!;
    expect(gradle.declarations.map((d) => d.name)).toEqual(['com.squareup.okhttp3:okhttp']);
  });

  it('lockfiles say what resolved from a registry', () => {
    expect([
      ...readResolved(
        'yarn.lock',
        '"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.1.0"\nleft-pad@^1.3.0:\n  version "1.3.0"\nlocal@file:../x:\n  version "0"\n',
      )!.names,
    ]).toEqual(['@babel/core', 'left-pad']);
    expect([
      ...readResolved(
        'go.sum',
        'github.com/a/b v1.0.0 h1:x=\ngithub.com/a/b v1.0.0/go.mod h1:y=\n',
      )!.names,
    ]).toEqual(['github.com/a/b']);
    expect([
      ...readResolved(
        'Gemfile.lock',
        'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.1.0)\n      x (>= 1)\n\nPLATFORMS\n',
      )!.names,
    ]).toEqual(['rack']);
    expect(
      privateScopesOf(
        '@acme:registry=https://npm.acme.internal/\n@pub:registry=https://registry.npmjs.org/\n',
      ),
    ).toEqual(['@acme']);
  });
});

describe('diff helpers (W21-05)', () => {
  it('numbers added lines on the new side', () => {
    const patch =
      '@@ -3,4 +3,5 @@\n   "dependencies": {\n-    "a": "1",\n+    "a": "2",\n+    "b": "1",\n     "c": "1"\n@@ -20,1 +21,2 @@\n x\n+y\n';
    expect([...addedLineNumbers(patch)]).toEqual([4, 5, 22]);
  });

  it('rebuilds an added file from its own patch, and nothing else', () => {
    expect(addedFileText('@@ -0,0 +1,2 @@\n+flask\n+requests\n')).toBe('flask\nrequests');
    expect(addedFileText('@@ -1,2 +1,2 @@\n flask\n+requests\n')).toBeNull();
  });
});

describe('the decision (W21-05)', () => {
  const tree = collectTree([
    {
      path: 'package.json',
      text: JSON.stringify(
        {
          name: 'app',
          dependencies: {
            react: '^18',
            'react-codeshift': '^1',
            crossenv: '^6',
            app: '*',
            '@acme/ui': '^1',
            '@babel/cor': '^7',
            loadsh: '^4',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'package-lock.json',
      text: JSON.stringify({
        packages: {
          'node_modules/react': { resolved: 'https://registry.npmjs.org/react/-/react-18.tgz' },
        },
      }),
    },
    { path: 'Cargo.toml', text: '[dependencies]\nserde_jsno = "1"\nserde_yml = "0.0.12"\n' },
  ]);
  const index = indexOf({
    npm: indexFromLines('npm', ['crossenv', '@babel/core', '@babel/parser']),
    cargo: indexFromLines(
      'cargo',
      ['serde_jsno\t2026-10-12T00:00:00Z\t14', 'serde_yml\t2024-03-29T00:00:00Z\t25224626'],
      { metadata: true },
    ),
  });
  const result = detectSlopsquats({
    reads: tree.reads,
    resolved: tree.resolved,
    index,
    popular,
    now: NOW,
    ownNames: tree.ownNames,
    privateScopes: tree.privateScopes,
  });
  const byName = new Map(result.signals.map((s) => [s.name, s]));

  it('files a missing package as slopsquat with the lockfile evidence', () => {
    const s = byName.get('react-codeshift')!;
    expect(s).toMatchObject({
      ruleId: SLOPSQUAT_RULE,
      existence: 'missing',
      severity: 4,
      confidence: 4,
      lockfile: 'unresolved',
      line: 5,
    });
    expect(s.reasons.join(' ')).toMatch(/not in the npm name index/);
    expect(s.reasons.join(' ')).toMatch(/never installed/);
  });

  it('a missing near-name of a popular package is slopsquat at confidence 5, naming the target', () => {
    expect(byName.get('loadsh')).toMatchObject({
      ruleId: SLOPSQUAT_RULE,
      confidence: 5,
      nearest: { target: 'lodash', pattern: 'edit' },
    });
    // Inside a scope nobody else can publish to, a near-name is no squat —
    // but a name that does not exist is still a hallucination.
    expect(byName.get('@babel/cor')).toMatchObject({
      ruleId: SLOPSQUAT_RULE,
      confidence: 4,
      nearest: null,
    });
  });

  it('an existing near-miss without metadata is flagged low; with young metadata, high; established, not at all', () => {
    expect(byName.get('crossenv')).toMatchObject({
      ruleId: NEAR_MISS_RULE,
      severity: 3,
      confidence: 2,
    });
    expect(byName.get('serde_jsno')).toMatchObject({
      ruleId: NEAR_MISS_RULE,
      severity: 4,
      confidence: 4,
      young: true,
      lowDownloads: true,
    });
    expect(byName.has('serde_yml')).toBe(false);
  });

  it('popular, own-workspace and private-scope names are never flagged', () => {
    for (const n of ['react', 'app', '@acme/ui']) expect(byName.has(n)).toBe(false);
  });

  it('with no index, existence is "not checked" and only the near-miss half speaks', () => {
    const blind = detectSlopsquats({
      reads: tree.reads,
      index: loadPackageIndex(path.join(tmpdir(), 'none-here')),
      popular,
      now: NOW,
    });
    expect(blind.signals.some((s) => s.ruleId === SLOPSQUAT_RULE)).toBe(false);
    expect(blind.signals.find((s) => s.name === 'crossenv')).toMatchObject({
      ruleId: NEAR_MISS_RULE,
      existence: 'not_checked',
    });
    expect(blind.notChecked.npm?.reason).toMatch(/scan-db-sync/);
  });

  it('diff mode reads only added lines and says so, one point more confident', () => {
    const diff = detectSlopsquats({
      reads: tree.reads,
      index,
      popular,
      now: NOW,
      addedLines: new Map([['package.json', new Set([5])]]),
    });
    expect(diff.declarations).toBe(1);
    expect(diff.signals).toHaveLength(1);
    expect(diff.signals[0]).toMatchObject({
      name: 'react-codeshift',
      addedInDiff: true,
      confidence: 5,
    });
  });

  it('the finding carries the evidence and a line-independent identity', () => {
    const finding = slopFinding(byName.get('loadsh')!, true);
    expect(finding).toMatchObject({
      dimension: 'dependency',
      scannerKey: 'slopsquat',
      ruleId: 'slopsquat',
      file: 'package.json',
      lineStart: 10,
      fingerprint: 'npm:loadsh',
      experimental: true,
    });
    expect(finding.evidenceQuote).toBe('package.json:10: "loadsh": "^4"');
    expect(finding.yields).toMatchObject({
      nearest: 'lodash',
      pattern: 'edit',
      registry: 'missing',
      added_in_diff: false,
    });
    expect(finding.suggestedFix).toMatch(/"lodash" is the popular package it resembles/);
  });
});
