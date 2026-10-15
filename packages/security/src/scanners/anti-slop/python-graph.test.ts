import { describe, expect, it } from 'vitest';
import { maskPython, pythonPhantomRefs, readPythonModule } from './python-graph.js';

// Python phantom references (W18-11). As with the TypeScript rule, most of
// these are cases that must NOT fire: a rule about bugs is only worth shipping
// if it is quiet on code that runs.

const run = (files: Record<string, string>, complete = true) =>
  pythonPhantomRefs(
    Object.entries(files).map(([path, source]) => ({ path, source })),
    { complete },
  );

const PKG = {
  'app/__init__.py': '',
  'app/utils.py': 'def format_date(d):\n    return d\n\nRATE = 3\n',
};

describe('the module reader', () => {
  it('masks strings and comments without moving a line', () => {
    const src = 'a = "x#y"  # from x import y\nb = """\nimport os\n"""\nc = 1\n';
    const masked = maskPython(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split('\n')).toHaveLength(src.split('\n').length);
    expect(masked).not.toContain('import');
  });

  it('reads module scope: defs, classes, assignments, imports, loops, with, walrus, global', () => {
    const mod = readPythonModule(
      [
        'import os.path',
        'import json as j',
        'from .x import (a,',
        '    b as bee)',
        'def f(): pass',
        'async def g():',
        '    global late',
        '    late = 1',
        'class C:',
        '    inner = 1',
        '    def method(self): pass',
        'x = y = 1',
        'p, (q, *r) = 1, (2, 3)',
        'ann: int = 3',
        'obj.attr = 4',
        'for i in range(3): pass',
        'with open("f") as fh: pass',
        'if (w := 5): pass',
        'try:',
        '    import simplejson as sj',
        'except ImportError:',
        '    sj = None',
        'type Alias = int',
        'match = 7',
      ].join('\n'),
    );
    for (const n of ['os', 'j', 'a', 'bee', 'f', 'g', 'late', 'C', 'x', 'y', 'p', 'q', 'r']) {
      expect(mod.defined.has(n), n).toBe(true);
    }
    for (const n of ['ann', 'i', 'fh', 'w', 'sj', 'Alias', 'match']) {
      expect(mod.defined.has(n), n).toBe(true);
    }
    for (const n of ['inner', 'method', 'attr', 'obj', 'b']) {
      expect(mod.defined.has(n), n).toBe(false);
    }
    // `match = 7` is an assignment to a soft keyword, not a match statement.
    expect(mod.dynamic).toBe(false);
    const guarded = mod.imports.find((i) => i.module === 'simplejson');
    expect(guarded?.guarded).toBe(true);
    expect(mod.imports.find((i) => i.module === 'x')?.names).toEqual(['a', 'b']);
  });
});

describe('phantom symbols (Python)', () => {
  it('reports names the target module never binds, one finding per statement', () => {
    const found = run({
      ...PKG,
      'app/views.py':
        '"""Docstring.\n\nfrom .utils import fake\n"""\nfrom .utils import (\n    format_date,\n    format_currency,\n    parse_money,\n)\n',
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ruleId: 'slop.phantom_symbol',
      file: 'app/views.py',
      line: 5,
      specifier: '.utils',
      name: 'format_currency, parse_money',
      statement: 'from .utils import ( format_date, format_currency, parse_money, )',
    });
  });

  it('reads package-local absolute imports, at the root and in a src layout', () => {
    expect(
      run({ ...PKG, 'app/views.py': 'from app.utils import format_date, nope\n' })[0]?.name,
    ).toBe('nope');
    const src = run({
      'src/shop/__init__.py': 'from .cart import Cart\n',
      'src/shop/cart.py': 'class Cart: pass\n',
      'src/shop/api.py': 'from shop import Cart, Checkout\nimport shop.cart\n',
    });
    expect(src.map((f) => f.name)).toEqual(['Checkout']);
  });

  it('counts a submodule as importable from its package', () => {
    expect(
      run({
        ...PKG,
        'app/views.py': 'from . import utils\nfrom app import utils as u\n',
      }),
    ).toEqual([]);
  });

  it('counts a name defined only inside a function or class as missing', () => {
    const found = run({
      ...PKG,
      'app/helpers.py': 'def outer():\n    hidden = 1\nclass K:\n    attr = 2\n',
      'app/views.py': 'from .helpers import outer, hidden, attr\n',
    });
    expect(found.map((f) => f.name)).toEqual(['hidden, attr']);
  });

  it('stays silent when the target namespace is built at run time', () => {
    const dynamicTargets = {
      'app/star.py': 'from os.path import *\n',
      'app/lazy.py': 'def __getattr__(name):\n    return name\n',
      'app/lazy2.py':
        'import lazy_loader as lazy\n__getattr__, __dir__, __all__ = lazy.attach(__name__)\n',
      'app/glob.py': 'for n in ("a", "b"):\n    globals()[n] = n\n',
      'app/allx.py': 'from .utils import RATE\n__all__ = ["RATE"] + extra\n',
      'app/selfmod.py': 'import sys\nsys.modules[__name__].thing = 1\n',
    };
    const importers = Object.keys(dynamicTargets).map(
      (p) => `from .${p.slice(4, -3)} import anything\n`,
    );
    expect(run({ ...PKG, ...dynamicTargets, 'app/views.py': importers.join('') })).toEqual([]);
  });

  it('never resolves a standard-library or third-party name into the snapshot', () => {
    // A module called logging.py inside a package does not shadow the stdlib
    // under absolute imports, and `requests` here is an installed distribution.
    expect(
      run({
        ...PKG,
        'app/logging.py': 'LEVEL = 1\n',
        'app/views.py': 'from logging import getLogger\nfrom requests import Session\n',
      }),
    ).toEqual([]);
  });

  it('skips TYPE_CHECKING imports, which a .pyi the reader never sees may satisfy', () => {
    expect(
      run({
        ...PKG,
        'app/views.py':
          'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .utils import StubOnly\n',
      }),
    ).toEqual([]);
  });

  it('skips a module two different sys.path entries would load differently', () => {
    expect(
      run({
        'tools/app/__init__.py': '',
        'tools/app/conf.py': 'X = 1\n',
        'tools/run.py': 'from app.conf import Y\n',
        'app/__init__.py': '',
        'app/conf.py': 'Y = 1\n',
      }),
    ).toEqual([]);
  });

  it('honours # noqa and skips fixtures and test-data corpora', () => {
    expect(
      run({
        ...PKG,
        'app/views.py': 'from .utils import broken  # noqa: F401\n',
        'tests/fixtures/bad.py': 'from app.utils import nope\n',
        'tests/data/cases/fmt.py': 'from . import A, B\n',
      }),
    ).toEqual([]);
  });
});

describe('phantom modules (Python)', () => {
  it('reports a relative or package-local module that does not exist, only on a complete read', () => {
    const files = {
      ...PKG,
      'app/views.py': 'from .billing import charge\nimport app.reports.weekly\n',
    };
    expect(run(files, false)).toEqual([]);
    const found = run(files);
    expect(found.map((f) => [f.ruleId, f.line, f.specifier])).toEqual([
      ['slop.phantom_module', 1, '.billing'],
      ['slop.phantom_module', 2, 'app.reports.weekly'],
    ]);
  });

  it('resolves namespace packages and climbs with ..', () => {
    expect(
      run({
        'ns/sub/mod.py': 'X = 1\n',
        'ns/other/use.py': 'from ..sub.mod import X\nfrom ns.sub import mod\n',
      }),
    ).toEqual([]);
  });

  it('does NOT report what may legitimately not exist in the tree', () => {
    const found = run({
      ...PKG,
      // Python's own "this may not exist".
      'app/a.py': 'try:\n    from ._speedups import fast\nexcept ImportError:\n    fast = None\n',
      // Generated at build time.
      'app/b.py': 'from ._version import version\nfrom .api_pb2 import Msg\n',
      // Tests import what their own setup puts on sys.path.
      'tests/test_x.py': 'from app.missing import y\n',
      // Climbs out of the repository.
      'app/c.py': 'from ... import outside\n',
      // A bare directory sharing a third-party name is no evidence.
      'examples/flask/app.py': 'from flask.views import View\n',
    });
    expect(found).toEqual([]);
  });

  it('skips underscore modules when the project builds extensions', () => {
    const files = {
      ...PKG,
      'setup.py':
        'from setuptools import Extension, setup\nsetup(ext_modules=[Extension("app._native", ["src/n.c"])])\n',
      'app/d.py': 'from ._native import go\nfrom .plain import go2\n',
    };
    expect(run(files).map((f) => f.specifier)).toEqual(['.plain']);
  });

  it('skips a package that aliases modules through sys.modules', () => {
    expect(
      run({
        'req/__init__.py': '',
        'req/packages.py':
          'import sys\nsys.modules["req.packages.urllib3"] = sys.modules["urllib3"]\n',
        'req/use.py': 'from req.packages.urllib3 import poolmanager\n',
      }),
    ).toEqual([]);
  });

  it('ignores non-Python files entirely', () => {
    expect(run({ 'src/a.ts': "import { x } from './nope';" })).toEqual([]);
  });
});
