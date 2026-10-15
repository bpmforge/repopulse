import { describe, expect, it } from 'vitest';
import {
  crateRoots,
  indexRustFile,
  maskRust,
  parseUseTree,
  rustPhantomRefs,
  rustUnusedItems,
} from './rust-graph.js';

// The Rust module graph (W18-14). Every case is a small in-memory crate: what
// is under test is resolution against Cargo's layout, not any real crate.

type Files = { path: string; source: string }[];
const complete = { complete: true };

describe('maskRust', () => {
  it('blanks comments and literal contents, keeping offsets', () => {
    const src = [
      'let a = "mod ghost; // not code"; // mod ghost;',
      '/* outer /* nested mod ghost; */ still comment */ let b = 1;',
      "let c = r#\"use crate::x::Y;\"#; let d = '{'; let e = b'}';",
      "fn f<'a>(x: &'a str) -> &'a str { x }",
    ].join('\n');
    const masked = maskRust(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split('\n').length).toBe(4);
    expect(masked).not.toContain('ghost');
    expect(masked).not.toContain('crate::x');
    expect(masked).toContain('let b = 1;');
    // A lifetime is not a char literal: the rest of the line survives.
    expect(masked).toContain("fn f<'a>(x: &'a str) -> &'a str { x }");
    // Braces inside char literals must not unbalance the frame count.
    expect(masked.split('\n')[2]).not.toMatch(/'[{}]'/);
  });

  it('keeps strings on request, for the name count', () => {
    expect(maskRust('#[serde(default = "port")] // port', true)).toBe(
      '#[serde(default = "port")]        ',
    );
  });
});

describe('parseUseTree', () => {
  it('expands groups, self, aliases and globs', () => {
    expect(parseUseTree(' crate::a::{self, B as C, d::{E, F}, g::*}')).toEqual([
      { segments: ['crate', 'a', 'self'], glob: false },
      { segments: ['crate', 'a', 'B'], glob: false, alias: 'C' },
      { segments: ['crate', 'a', 'd', 'E'], glob: false },
      { segments: ['crate', 'a', 'd', 'F'], glob: false },
      { segments: ['crate', 'a', 'g'], glob: true },
    ]);
    expect(parseUseTree(' ::std::fmt')).toEqual([{ segments: ['::', 'std', 'fmt'], glob: false }]);
    expect(parseUseTree(' crate::a::{B')).toBeNull();
  });
});

describe('crate roots', () => {
  it("follows Cargo's default layout, relative to the package", () => {
    expect(
      crateRoots([
        'src/lib.rs',
        'src/main.rs',
        'src/bin/tool.rs',
        'build.rs',
        'tests/it.rs',
        'crates/core/src/lib.rs',
        // Modules, not roots: a tests/ or build.rs INSIDE src is a module name.
        'src/runtime/tests/queue.rs',
        'src/build.rs',
        'src/a.rs',
        // Scanner fixtures are broken on purpose.
        'fixtures/rust/src/lib.rs',
      ]),
    ).toEqual([
      'build.rs',
      'crates/core/src/lib.rs',
      'src/bin/tool.rs',
      'src/lib.rs',
      'src/main.rs',
      'tests/it.rs',
    ]);
  });
});

describe('slop.phantom_module', () => {
  it('reports a `mod` with no file, and resolves every real layout', () => {
    const files: Files = [
      {
        path: 'src/lib.rs',
        source: [
          'mod flat;',
          'mod nested;',
          'pub mod ghost;',
          'mod inline { mod deep; }',
          '#[path = "elsewhere.rs"] mod moved;',
          'macro_rules! m { () => { mod in_macro; } }',
        ].join('\n'),
      },
      { path: 'src/flat.rs', source: 'mod child;' },
      // A non-mod.rs file's children live in a directory named after it.
      { path: 'src/flat/child.rs', source: 'pub fn f() {}' },
      { path: 'src/nested/mod.rs', source: 'mod sibling;' },
      { path: 'src/nested/sibling.rs', source: '' },
      { path: 'src/inline/deep.rs', source: '' },
    ];
    const refs = rustPhantomRefs(files, complete);
    expect(refs.map((r) => [r.ruleId, r.file, r.line, r.specifier])).toEqual([
      ['slop.phantom_module', 'src/lib.rs', 3, 'ghost'],
    ]);
    expect(refs[0]?.statement).toBe('pub mod ghost;');
    expect(refs[0]?.message).toContain('src/ghost.rs');
    expect(refs[0]?.message).toContain('src/ghost/mod.rs');
  });

  it('says nothing about a missing file when the read was not complete', () => {
    const files: Files = [{ path: 'src/lib.rs', source: 'mod ghost;' }];
    expect(rustPhantomRefs(files, { complete: false })).toEqual([]);
  });

  it('says nothing when the file would sit in a directory the reader skips', () => {
    // readSnapshotSources never descends into build/ or vendor/.
    const files: Files = [{ path: 'src/lib.rs', source: 'mod build;\nmod vendor;' }];
    expect(rustPhantomRefs(files, complete)).toEqual([]);
  });

  it('reports a use path through a module the parent does not have', () => {
    const files: Files = [
      { path: 'src/lib.rs', source: 'mod a;\npub struct Root;\nuse crate::nowhere::Thing;' },
      { path: 'src/a.rs', source: 'pub fn f() {}' },
    ];
    expect(rustPhantomRefs(files, complete).map((r) => [r.ruleId, r.line, r.specifier])).toEqual([
      ['slop.phantom_module', 3, 'nowhere'],
    ]);
  });
});

describe('slop.phantom_symbol', () => {
  const crate = (extra: Files = []): Files => [
    {
      path: 'src/lib.rs',
      source: [
        'pub mod money;',
        'mod shapes;',
        'mod generated;',
        'mod globbed;',
        'pub use money::Cents;',
        '#[macro_export] macro_rules! dollars { () => {} }',
      ].join('\n'),
    },
    {
      path: 'src/money.rs',
      source: [
        'pub struct Cents(pub u64);',
        'pub enum Currency { Usd, Eur }',
        'pub(crate) const RATE: u32 = 1;',
        'pub const fn zero() -> Cents { Cents(0) }',
        'pub use std::fmt::Display as Show;',
        'mod inner;',
      ].join('\n'),
    },
    { path: 'src/money/inner.rs', source: 'use super::{Cents, Missing};\nuse crate::dollars;' },
    { path: 'src/shapes.rs', source: 'pub fn area() {}' },
    // A macro at item level can define anything: unknowable surface.
    { path: 'src/generated.rs', source: 'define_ops!(Add, Sub);' },
    { path: 'src/globbed.rs', source: 'pub use crate::money::*;' },
    ...extra,
  ];

  it('reports names the target module does not define, one finding per statement', () => {
    const files = crate([
      {
        path: 'src/main.rs',
        source: ['mod app;', 'fn main() {}'].join('\n'),
      },
      {
        path: 'src/app.rs',
        source: ['use crate::nothing_here;', 'fn run() {}'].join('\n'),
      },
    ]);
    files[0] = {
      path: 'src/lib.rs',
      source: `${files[0]!.source}\nuse crate::money::{Cents, Currency::Usd, RATE, Show, zero, ToDollars, Rounding};`,
    };
    const refs = rustPhantomRefs(files, complete);
    expect(refs.map((r) => [r.ruleId, r.file, r.line, r.name])).toEqual([
      ['slop.phantom_symbol', 'src/app.rs', 1, 'nothing_here'],
      ['slop.phantom_symbol', 'src/lib.rs', 7, 'ToDollars, Rounding'],
      ['slop.phantom_symbol', 'src/money/inner.rs', 1, 'Missing'],
    ]);
    expect(refs[1]?.specifier).toBe('src/money.rs');
  });

  it('never judges an unknowable module, a glob, or an extern path', () => {
    const files = crate([
      {
        path: 'src/bin/tool.rs',
        source: ['use serde::NotOurs;', 'use std::collections::Nope;', 'fn main() {}'].join('\n'),
      },
    ]);
    files[0] = {
      path: 'src/lib.rs',
      source: `${files[0]!.source}\nuse crate::generated::Mul;\nuse crate::globbed::Anything;\nuse crate::shapes::*;`,
    };
    // Only the fixture's own planted import in inner.rs remains.
    expect(rustPhantomRefs(files, complete).map((r) => r.file)).toEqual(['src/money/inner.rs']);
  });

  it('skips use statements inside macro_rules bodies', () => {
    const files: Files = [
      { path: 'src/lib.rs', source: 'mod a;\nmacro_rules! m { () => { use crate::a::Nope; } }' },
      { path: 'src/a.rs', source: 'pub fn f() {}' },
    ];
    expect(rustPhantomRefs(files, complete)).toEqual([]);
  });

  it('resolves modules declared inside an item-level macro (cfg_if!)', () => {
    const files: Files = [
      {
        path: 'src/lib.rs',
        source:
          'cfg_if::cfg_if! {\n    if #[cfg(unix)] {\n        mod sys;\n    }\n}\n' +
          'use crate::sys::huge_pages;\n',
      },
      { path: 'src/sys.rs', source: 'pub fn page_size() -> usize { 4096 }' },
    ];
    expect(rustPhantomRefs(files, complete).map((r) => r.name)).toEqual(['huge_pages']);
  });
});

describe('slop.unused_export for crate-visible Rust items', () => {
  it('reports a pub(crate) item nothing in the snapshot mentions', () => {
    const files: Files = [
      { path: 'src/lib.rs', source: 'mod util;\npub fn run() { util::used(); }' },
      {
        path: 'src/util.rs',
        source: [
          'pub(crate) fn used() {}',
          'pub(crate) fn never_called() {}',
          'pub(super) struct Orphan;',
          '// A plain pub item is API for other crates: never reported.',
          'pub fn public_api() {}',
          '#[allow(dead_code)]',
          'pub(crate) fn acknowledged() {}',
          'pub(crate) fn default_port() -> u16 { 80 }',
          '#[derive(serde::Deserialize)] struct Cfg { #[serde(default = "default_port")] port: u16 }',
        ].join('\n'),
      },
    ];
    const unused = rustUnusedItems(files);
    expect(unused.map((u) => [u.file, u.line, u.name])).toEqual([
      ['src/util.rs', 2, 'never_called'],
      ['src/util.rs', 3, 'Orphan'],
    ]);
    expect(unused[0]?.ruleId).toBe('slop.unused_export');
    expect(unused[0]?.declaration).toBe('pub(crate) fn never_called() {}');
  });

  it('counts uses in files the module walk cannot reach (#[path] modules)', () => {
    const files: Files = [
      { path: 'src/lib.rs', source: 'mod util;\n#[path = "sys/unix.rs"] mod imp;' },
      { path: 'src/util.rs', source: 'pub(crate) struct Spawned;' },
      { path: 'src/sys/unix.rs', source: 'fn spawn() -> crate::util::Spawned { todo!() }' },
    ];
    expect(rustUnusedItems(files)).toEqual([]);
  });

  it('respects #![allow(dead_code)] and macro-built identifiers', () => {
    const allowed: Files = [
      { path: 'src/lib.rs', source: 'mod util;' },
      { path: 'src/util.rs', source: '#![allow(dead_code)]\npub(crate) fn spare() {}' },
    ];
    expect(rustUnusedItems(allowed)).toEqual([]);
    const pasted: Files = [
      { path: 'src/lib.rs', source: 'mod util;\npaste::paste! { fn x() { [<sp are>](); } }' },
      { path: 'src/util.rs', source: 'pub(crate) fn spare() {}' },
    ];
    expect(rustUnusedItems(pasted)).toEqual([]);
  });
});

describe('indexRustFile', () => {
  it('keeps brace frames balanced across macros, literals and inline modules', () => {
    const idx = indexRustFile(
      [
        "const OPEN: char = '{';",
        'lazy_static! { static ref X: u8 = 1; }',
        'mod outer {',
        '    fn f() { if !(true) { let _ = "}"; } }',
        '    mod inner;',
        '}',
        'mod after;',
      ].join('\n'),
    );
    expect(idx.mods.map((m) => [m.name, m.inline, m.body])).toEqual([
      ['outer', [], true],
      ['inner', ['outer'], false],
      ['after', [], false],
    ]);
    // lazy_static! at item level: the module's surface is unknowable.
    expect(idx.unknowable).toBe(true);
  });
});
