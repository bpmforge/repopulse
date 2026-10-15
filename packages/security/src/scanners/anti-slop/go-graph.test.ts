import { describe, expect, it } from 'vitest';
import {
  buildGoGraph,
  goDeclarations,
  goImports,
  goPhantomRefs,
  goUnusedExports,
  maskGo,
  parseGoMod,
  resolveGoImport,
} from './go-graph.js';

// The Go fast lane (W18-12). Both phantom rules are compile errors, so a
// repository that builds has none: most of these cases are building code that
// a careless reading would call broken.

const GO_MOD = { path: 'go.mod', source: 'module example.com/app\n\ngo 1.22\n' };

const run = (files: { path: string; source: string }[], complete = true) =>
  goPhantomRefs([GO_MOD, ...files], { complete });

const CACHE = {
  path: 'internal/cache/lru.go',
  source: [
    'package cache',
    '',
    '// Thing is documented; the comment must not hide the declaration.',
    'type LRU struct{ size int }',
    '',
    'func NewLRU(n int) *LRU { return &LRU{size: n} }',
    '',
    '// Get is a METHOD: cache.Get is not a package-level name.',
    'func (c *LRU) Get(k string) string { return k }',
    '',
    'const (',
    '\tSmall = iota',
    '\tLarge',
    ')',
    '',
    'var (',
    '\tDefaultSize, MaxSize = 16, 1024',
    '\tregistry = map[string]int{',
    '\t\t"Nested": 1,',
    '\t}',
    ')',
    '',
    'func Map[K comparable, V any](m map[K]V) {}',
  ].join('\n'),
};

describe('reading Go text', () => {
  it('masks comments, strings and multi-line raw strings, keeping offsets', () => {
    const src = 'a := "x//y" // c\nb := `one\ntwo` /* d */ + \'"\'';
    const masked = maskGo(src);
    expect(masked).toHaveLength(src.length);
    expect(masked.split('\n')).toHaveLength(3);
    expect(masked).not.toContain('//');
    expect(masked).not.toContain('one');
    expect(maskGo(src, true)).toContain('"x//y"');
  });

  it('reads top-level declarations — funcs, types, grouped consts and vars — and not methods', () => {
    const names = goDeclarations(maskGo(CACHE.source)).map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'LRU',
        'NewLRU',
        'Small',
        'Large',
        'DefaultSize',
        'MaxSize',
        'registry',
        'Map',
      ]),
    );
    expect(names).not.toContain('Get');
    expect(names).not.toContain('size');
  });

  it('reads single, grouped, aliased, dot and blank imports', () => {
    const imps = goImports(
      [
        'package x',
        'import "fmt"',
        'import c "example.com/app/internal/cache"',
        'import (',
        '\t"strings" // trailing comment',
        '\t_ "example.com/app/internal/driver"',
        '\t. "example.com/app/internal/dsl"',
        ')',
      ].join('\n'),
    );
    expect(imps.map((i) => [i.alias, i.path])).toEqual([
      [null, 'strings'],
      ['_', 'example.com/app/internal/driver'],
      ['.', 'example.com/app/internal/dsl'],
      [null, 'fmt'],
      ['c', 'example.com/app/internal/cache'],
    ]);
  });

  it('reads go.mod: module path, require and replace (block and single-line)', () => {
    const mod = parseGoMod(
      [
        'module "example.com/app" // quoted is legal',
        'require example.com/app/tools v0.1.0',
        'require (',
        '\texample.com/app/api v1.2.0 // indirect',
        '\tgithub.com/x/y v1.0.0',
        ')',
        'replace example.com/app/sdk => ./sdk',
      ].join('\n'),
    );
    expect(mod.module).toBe('example.com/app');
    expect(mod.foreign).toEqual(
      expect.arrayContaining([
        'example.com/app/tools',
        'example.com/app/api',
        'github.com/x/y',
        'example.com/app/sdk',
      ]),
    );
  });

  it('maps import paths to directories by the longest module, and never into a required module', () => {
    const graph = buildGoGraph([
      { path: 'go.mod', source: 'module example.com/app\nrequire example.com/app/api v1.0.0\n' },
      { path: 'tools/go.mod', source: 'module example.com/app/tools\n' },
    ]);
    expect(resolveGoImport(graph, 'example.com/app')).toBe('');
    expect(resolveGoImport(graph, 'example.com/app/internal/x')).toBe('internal/x');
    expect(resolveGoImport(graph, 'example.com/app/tools/gen')).toBe('tools/gen');
    expect(resolveGoImport(graph, 'example.com/app/api/client')).toBeNull();
    expect(resolveGoImport(graph, 'example.com/application/x')).toBeNull();
    expect(resolveGoImport(graph, 'github.com/other/x')).toBeNull();
  });
});

describe('phantom identifiers', () => {
  it('reports a package-qualified exported name the package does not declare', () => {
    const found = run([
      CACHE,
      {
        path: 'server/server.go',
        source: [
          'package server',
          '',
          'import "example.com/app/internal/cache"',
          '',
          'func New() {',
          '\tc := cache.NewLRU(cache.DefaultSize)',
          '\t_ = cache.NewTTLCache(10)',
          '\t_ = c',
          '}',
        ].join('\n'),
      },
    ]);
    expect(found).toEqual([
      expect.objectContaining({
        ruleId: 'slop.phantom_symbol',
        file: 'server/server.go',
        line: 7,
        name: 'NewTTLCache',
        specifier: 'example.com/app/internal/cache',
        statement: '_ = cache.NewTTLCache(10)',
      }),
    ]);
  });

  it('uses the package clause, not the last path element, and honours an explicit alias', () => {
    const found = run([
      { path: 'pkg/v2/x.go', source: 'package widgets\n\nfunc Make() {}' },
      {
        path: 'a.go',
        source: [
          'package app',
          'import (',
          '\t"example.com/app/pkg/v2"',
          '\tw2 "example.com/app/pkg/v2"',
          ')',
          'func f() { widgets.Make(); w2.Make(); w2.Break() }',
        ].join('\n'),
      },
    ]);
    expect(found.map((f) => f.name)).toEqual(['Break']);
  });

  it('counts names declared in any file of the package, including _test.go and build-tagged files', () => {
    const found = run([
      { path: 'store/store.go', source: 'package store\nfunc Open() {}' },
      { path: 'store/store_linux.go', source: '//go:build linux\npackage store\nfunc Sync() {}' },
      { path: 'store/export_test.go', source: 'package store\nvar Internal = 1' },
      {
        path: 'store/store_test.go',
        source:
          'package store_test\nimport "example.com/app/store"\nfunc T() { store.Open(); store.Sync(); _ = store.Internal }',
      },
    ]);
    expect(found).toEqual([]);
  });

  it('stays silent when the package name is shadowed by a local of the same name', () => {
    const found = run([
      { path: 'config/config.go', source: 'package config\ntype Config struct{ Port int }' },
      {
        path: 'srv.go',
        source: [
          'package app',
          'import "example.com/app/config"',
          'func run(config *config.Config) int {',
          '\treturn config.Port',
          '}',
        ].join('\n'),
      },
    ]);
    expect(found).toEqual([]);
  });

  it('ignores field chains, comments, strings, unexported names, blank and dot imports', () => {
    const found = run([
      { path: 'model/model.go', source: 'package model\ntype User struct{}' },
      { path: 'drv/drv.go', source: 'package drv\nfunc init() {}' },
      {
        path: 'a.go',
        source: [
          'package app',
          'import (',
          '\t"example.com/app/model"',
          '\t_ "example.com/app/drv"',
          '\t. "example.com/app/drv"',
          ')',
          '// model.Ghost in a comment is not a reference',
          'var s = "model.Ghost"',
          'var u model.User',
          'var x = obj.model.Ghost',
          'var y = model.lowercase',
        ].join('\n'),
      },
    ]);
    expect(found).toEqual([]);
  });

  it('does not judge a package with a go:generate directive, or a package with two names', () => {
    const found = run([
      {
        path: 'gen/gen.go',
        source: 'package gen\n//go:generate stringer -type=Kind\ntype Kind int',
      },
      { path: 'mixed/a.go', source: 'package mixed\nfunc A() {}' },
      { path: 'mixed/tool.go', source: '//go:build ignore\npackage main\nfunc main() {}' },
      {
        path: 'a.go',
        source:
          'package app\nimport (\n\t"example.com/app/gen"\n\t"example.com/app/mixed"\n)\nvar _ = gen.Kind_name\nvar _ = mixed.Gone',
      },
    ]);
    expect(found).toEqual([]);
  });
});

describe('phantom packages', () => {
  it('reports an in-module import whose directory has no Go files — only on a complete read', () => {
    const files = [
      {
        path: 'cmd/api/main.go',
        source: 'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/internal/ratelimit"\n)\n',
      },
    ];
    expect(run(files)).toEqual([
      expect.objectContaining({
        ruleId: 'slop.phantom_module',
        file: 'cmd/api/main.go',
        line: 5,
        name: null,
        specifier: 'example.com/app/internal/ratelimit',
        statement: '"example.com/app/internal/ratelimit"',
      }),
    ]);
    expect(run(files, false)).toEqual([]);
  });

  it('never fires on other modules, required sub-modules, unread directories or fixtures', () => {
    const found = goPhantomRefs(
      [
        { path: 'go.mod', source: 'module example.com/app\nrequire example.com/app/api v1.0.0\n' },
        {
          path: 'main.go',
          source: [
            'package main',
            'import (',
            '\t"github.com/spf13/cobra"',
            '\t"example.com/app/api/client"',
            '\t"example.com/app/vendor/x"',
            '\t"example.com/app/build/gen"',
            '\t"example.com/app/testdata/y"',
            ')',
          ].join('\n'),
        },
        { path: 'testdata/broken/b.go', source: 'package b\nimport "example.com/app/nope"' },
      ],
      { complete: true },
    );
    expect(found).toEqual([]);
  });

  it('is off entirely without a go.mod', () => {
    expect(
      goPhantomRefs([{ path: 'a.go', source: 'package a\nimport "example.com/app/x"' }], {
        complete: true,
      }),
    ).toEqual([]);
  });
});

describe('unused exports in internal packages', () => {
  const user = {
    path: 'server/server.go',
    source:
      'package server\nimport "example.com/app/internal/cache"\nvar c = cache.NewLRU(cache.Small)',
  };

  it('reports an exported func, type or const of an internal package that nothing names', () => {
    const found = goUnusedExports([GO_MOD, CACHE, user], { complete: true });
    expect(found.map((f) => f.name).sort()).toEqual(['Large', 'Map']);
    expect(found[0]).toMatchObject({ ruleId: 'slop.unused_export', file: 'internal/cache/lru.go' });
  });

  it('skips vars (set by -ldflags -X), non-internal packages, unimported packages, generated files and incomplete reads', () => {
    const files = [
      GO_MOD,
      { path: 'internal/version/version.go', source: 'package version\nvar Version = "dev"' },
      { path: 'pkg/public/p.go', source: 'package public\nfunc Unused() {}' },
      { path: 'internal/orphan/o.go', source: 'package orphan\nfunc Unused() {}' },
      {
        path: 'internal/mocks/mock_store.go',
        source: '// Code generated by mockery. DO NOT EDIT.\n\npackage mocks\nfunc NewStore() {}',
      },
      {
        path: 'a.go',
        source:
          'package app\nimport (\n\t"example.com/app/internal/version"\n\t"example.com/app/pkg/public"\n\t"example.com/app/internal/mocks"\n)\nvar _ = version.Version',
      },
    ];
    expect(goUnusedExports(files, { complete: true })).toEqual([]);
    expect(goUnusedExports([GO_MOD, CACHE, user], { complete: false })).toEqual([]);
  });
});
