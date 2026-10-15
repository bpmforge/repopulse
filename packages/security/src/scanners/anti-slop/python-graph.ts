import { PHANTOM_MODULE_RULE_ID, PHANTOM_SYMBOL_RULE_ID, type PhantomRef } from './phantom-refs.js';

// Python phantom references (W18-11, mechanical-checks plan §A and §F).
//
// The same two bugs as phantom-refs.ts, in Python: `from .utils import
// format_currency` where utils.py never defined one, and `from .billing import
// x` where billing.py was never written. Python has no compiler to refuse
// either, so both reach production and fail at import time — usually on the
// first request that touches the module, not at deploy.
//
// The answer comes from the repository's own files, and only the imports the
// repository itself can answer are read: relative imports, and absolute
// imports whose first segment is a package in the snapshot (top level, `src/`,
// or the directory Python would put on sys.path for the importing script).
// Everything else is the standard library or an installed distribution, which
// this lane cannot see — slopsquat and the dependency scanner own those.
//
// WHAT MAKES A TARGET UNKNOWABLE. A Python module's namespace can be built at
// run time in ways no reading of its text can follow. Any of these and the
// symbol check stands down for that module rather than guessing: a star
// import, a module-level `__getattr__` (PEP 562, which is how lazy-loading
// packages expose their surface), `globals()` / `vars()` / `locals()` /
// `exec`, a write to `sys.modules[__name__]`, or an `__all__` that is
// anything but a literal list.
//
// WHAT MAKES A MISSING MODULE UNPROVABLE. Not every module is a .py file in
// the tree: C/Cython/Rust extensions, setuptools_scm's `_version.py`, protobuf
// `_pb2` modules and anything a package aliases through `sys.modules` exist
// only after a build. Those are skipped by name and by the build hints the
// snapshot does show, and an import inside `try:` is never reported — that is
// Python's own spelling of "this may not exist".

export const PY = /\.py$/;

/** Module attributes every module has without defining them. */
const INTRINSIC = new Set([
  '__name__',
  '__doc__',
  '__file__',
  '__path__',
  '__package__',
  '__spec__',
  '__loader__',
  '__builtins__',
  '__cached__',
  '__dict__',
  '__annotations__',
]);

/**
 * Standard-library top-level names, including ones removed since 3.11 that
 * older code still imports. A local `logging.py` beside the importer does not
 * shadow the standard library under absolute imports, so these are never
 * resolved into the snapshot.
 */
const STDLIB = new Set(
  (
    '__future__ abc antigravity argparse array ast asynchat asyncio asyncore atexit audioop ' +
    'base64 bdb binascii bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code ' +
    'codecs codeop collections colorsys compileall concurrent configparser contextlib ' +
    'contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib ' +
    'dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp ' +
    'fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob ' +
    'graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib ' +
    'inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma ' +
    'mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing ' +
    'netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev ' +
    'pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath ' +
    'pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri ' +
    'random re readline reprlib resource rlcompleter runpy sched secrets select selectors ' +
    'shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 ' +
    'sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct ' +
    'subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile ' +
    'termios textwrap this threading time timeit tkinter token tokenize tomllib trace ' +
    'traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu ' +
    'uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc ' +
    'zipapp zipfile zipimport zlib zoneinfo'
  ).split(' '),
);

/** Module names that are generated at build or install time, never committed. */
const GENERATED_MODULE = /(^|_)version$|^_?version|_pb2(_grpc)?$|_rc$|^_?generated|_build_info$/i;

/** Signs that the project builds compiled extension modules. */
const EXTENSION_HINT =
  /\bExtension\s*\(|\bext_modules\b|\bcythonize\b|\bcffi_modules\b|\bffibuilder\b|\bRustExtension\b|#\[pymodule\]|\bpybind11\b|\bmypycify\b/;

/** Path segments readSnapshotSources never reads — a miss there proves nothing. */
const UNREAD_SEGMENT =
  /(^|\/)(node_modules|dist|build|coverage|vendor|_vendor|\.venv|venv|site-packages|generated|__generated__)(\/|$)/;

/** Tests, docs and examples import what their own setup puts on sys.path. */
const TEST_PATH =
  /(^|\/)(tests?|testing|docs?|examples?|benchmarks?|scripts?)\/|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/;

/**
 * Code that is broken or foreign on purpose: a scanner's trigger cases, and the
 * input corpora formatters and linters keep under tests/data.
 */
const FIXTURE_PATH =
  /(^|\/)(fixtures?|__fixtures__|testdata|test-data|test_data)\/|(^|\/)tests?\/(data|cases|samples|resources)\//;

// ---------------------------------------------------------------------------
// Lexing

/**
 * Blanks comments and string contents, keeping offsets and newlines.
 *
 * Quote characters are kept so a blanked string still reads as a string, and
 * triple-quoted strings (docstrings) keep their newlines, so a masked line
 * number is the source's line number.
 */
const spaces = (run: string): string => ' '.repeat(run.length);

export function maskPython(source: string): string {
  // One regex pass, not a character loop: the loop version spent seconds on a
  // large codebase's docstrings. Alternatives are tried left to right at each
  // position, so a `#` inside a string is part of the string.
  return source.replace(PY_TOKEN, (token: string) => {
    if (token.startsWith('#')) return token.replace(/[^\n]+/g, spaces);
    const q = token[0] as string;
    const quote = token.startsWith(q.repeat(3)) ? q.repeat(3) : q;
    const closed = token.length >= quote.length * 2 && token.endsWith(quote);
    const inner = token.slice(quote.length, closed ? token.length - quote.length : token.length);
    return quote + inner.replace(/[^\n]+/g, spaces) + (closed ? quote : '');
  });
}

/**
 * Comments and string literals. An unterminated single-quoted string ends at
 * the line, as the tokenizer would, rather than swallowing the rest of the
 * file; an unterminated triple-quoted one runs to the end, as it does.
 */
const PY_TOKEN =
  /#[^\n]*|'''(?:\\[\s\S]|[^\\])*?(?:'''|$)|"""(?:\\[\s\S]|[^\\])*?(?:"""|$)|'(?:\\[\s\S]|[^'\\\n])*'?|"(?:\\[\s\S]|[^"\\\n])*"?/g;

interface Statement {
  /** Masked text, physical lines joined. */
  text: string;
  /** Offset of the statement's first character in the source. */
  start: number;
  /** Offset just past its end. */
  end: number;
  indent: number;
}

/** Logical lines (brackets and backslashes joined), split on top-level `;`. */
function statements(masked: string): Statement[] {
  const out: Statement[] = [];
  let depth = 0;
  let stmtStart = 0;
  const indentAt = (lineStart: number): number => {
    let j = lineStart;
    while (masked.charCodeAt(j) === 32 || masked.charCodeAt(j) === 9) j++;
    return j - lineStart;
  };
  // Indentation of a logical line is its first physical line's.
  let indent = indentAt(0);
  const push = (end: number): void => {
    const text = masked.slice(stmtStart, end);
    const trimmed = text.trimStart();
    if (trimmed) {
      out.push({
        text: text.replace(/\\\n/g, ' '),
        start: stmtStart + text.length - trimmed.length,
        end,
        indent,
      });
    }
  };
  // Only brackets, `;` and newlines change state, so the scan jumps between
  // them natively instead of visiting every character.
  const interesting = /[()[\]{};\n]/g;
  for (let m = interesting.exec(masked); m; m = interesting.exec(masked)) {
    const i = m.index;
    const c = m[0];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ';') {
      if (depth > 0) continue;
      push(i);
      stmtStart = i + 1;
    } else {
      if (depth > 0 || masked.charCodeAt(i - 1) === 92) continue;
      push(i);
      stmtStart = i + 1;
      indent = indentAt(stmtStart);
    }
  }
  push(masked.length);
  return out;
}

function lineIndex(source: string): (offset: number) => number {
  const starts = [0];
  for (let k = 0; k < source.length; k++) if (source.charCodeAt(k) === 10) starts.push(k + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---------------------------------------------------------------------------
// Reading a module

export interface PyImport {
  /** Leading dots of a relative import; 0 for absolute. */
  level: number;
  /** Dotted module path after the dots ('' for `from . import x`). */
  module: string;
  /** `from M import a, b` names; null for `import M` (module only). */
  names: string[] | null;
  /** `from M import *`. */
  star: boolean;
  /** Inside a try/except: Python's own "this may not exist". */
  guarded: boolean;
  /** Inside `if TYPE_CHECKING:` — read by the type checker, maybe from a .pyi. */
  typeOnly: boolean;
  start: number;
  end: number;
}

export interface PyModule {
  /** Names bound at module scope, by any statement. */
  defined: Set<string>;
  imports: PyImport[];
  /** The namespace is built at run time (see the top of this file). */
  dynamic: boolean;
  /** `__path__` is touched: submodules may live elsewhere. */
  pathDynamic: boolean;
  /**
   * Writes a NAMED entry into sys.modules (a string or f-string key, or
   * update/setdefault): other dotted names may be aliases. A variable key is
   * left out — it is how loaders register synthetic modules (jinja2's compiled
   * templates), which alias nothing a source file imports.
   */
  aliasesModules: boolean;
}

const IDENT_RE = /^[A-Za-z_]\w*$/;

/** Bare names bound by an assignment or loop target such as `a, (b, *c)`. */
function targetNames(target: string): string[] {
  const t = target.trim().replace(/^\*/, '').trim();
  if (IDENT_RE.test(t)) return [t];
  const inner = /^[([]([\s\S]*)[)\]]$/.exec(t);
  const body = inner ? (inner[1] as string) : t;
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k <= body.length; k++) {
    const ch = body[k];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if ((ch === ',' && depth === 0) || k === body.length) {
      parts.push(body.slice(from, k));
      from = k + 1;
    }
  }
  if (parts.length === 1 && !inner) return [];
  return parts.flatMap((p) => (p.trim() ? targetNames(p) : []));
}

/** Splits `a = b = expr` at top-level single `=` signs. */
function assignmentTargets(stmt: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let k = 0; k < stmt.length; k++) {
    const ch = stmt[k] as string;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) {
      const prev = stmt[k - 1] ?? '';
      const next = stmt[k + 1] ?? '';
      if (next === '=' || '=!<>:+-*/%&|^@'.includes(prev)) {
        if (next === '=') k++;
        continue;
      }
      parts.push(stmt.slice(from, k));
      from = k + 1;
    }
  }
  // An annotation without a value (`x: int`) binds nothing at run time, but a
  // reader cannot tell one written for a dataclass-style module from a slip,
  // so it counts as defined: the cost of that is a missed finding.
  if (parts.length === 0) {
    const annotated = /^([A-Za-z_]\w*)\s*:(?!=)/.exec(stmt);
    return annotated ? [annotated[1] as string] : [];
  }
  return parts.flatMap((p) => {
    const annotated = /^([A-Za-z_]\w*)\s*:(?!=)/.exec(p.trim());
    return annotated ? [annotated[1] as string] : targetNames(p);
  });
}

/** The colon that ends a compound header: the first at bracket depth 0. */
function headerColon(s: string): number {
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0 && s[k + 1] !== '=') {
      // `lambda x: …` in a header's condition is the lambda's colon, not ours.
      if (/\blambda\b[^:]*$/.test(s.slice(0, k))) continue;
      return k;
    }
  }
  return -1;
}

const COMPOUND =
  /^(if|elif|else|for|async\s+for|while|try|except|finally|with|async\s+with|def|async\s+def|class|match|case)\b/;

function importNames(clause: string): { names: string[]; bound: string[]; star: boolean } {
  const body = clause.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (body.trim() === '*') return { names: [], bound: [], star: true };
  const names: string[] = [];
  const bound: string[] = [];
  for (const part of body.split(',')) {
    const [name, alias] = part.trim().split(/\s+as\s+/);
    if (!name || !IDENT_RE.test(name.trim())) continue;
    names.push(name.trim());
    bound.push((alias ?? name).trim());
  }
  return { names, bound, star: false };
}

/** Reads one Python module: what it binds at module scope and what it imports. */
export function readPythonModule(source: string, masked = maskPython(source)): PyModule {
  const defined = new Set<string>();
  const imports: PyImport[] = [];
  let dynamic = false;

  type Kind = 'scope' | 'guard' | 'typecheck' | 'other';
  const stack: { indent: number; kind: Kind }[] = [];
  const lastHeader = new Map<number, string>();

  for (const st of statements(masked)) {
    while (stack.length && (stack[stack.length - 1] as { indent: number }).indent >= st.indent) {
      stack.pop();
    }
    const s = st.text.replace(/\s+/g, ' ').trim();
    const inScope = stack.some((e) => e.kind === 'scope');
    const guarded = stack.some((e) => e.kind === 'guard');
    const typeOnly = stack.some((e) => e.kind === 'typecheck');

    // A compound header opens a block; anything after its colon on the same
    // line is a one-line body, read as a statement of that block.
    let body = s;
    const header = COMPOUND.exec(s);
    const colon = header ? headerColon(s) : -1;
    // `match` and `case` are soft keywords: `match = pattern.match(x)` is an
    // assignment, and only a header that ends in its own colon is a statement.
    const soft = header && /^(match|case)$/.test(header[1] as string) && !s.endsWith(':');
    if (header && colon !== -1 && !soft) {
      const keyword = (header[1] as string).replace(/\s+/g, ' ');
      let kind: Kind = 'other';
      if (/^(async )?def$|^class$/.test(keyword)) kind = 'scope';
      else if (keyword === 'try' || keyword === 'except' || keyword === 'finally') kind = 'guard';
      else if (keyword === 'else') {
        const before = lastHeader.get(st.indent);
        kind = before === 'try' || before === 'except' ? 'guard' : 'other';
      } else if (/^if (typing\.)?TYPE_CHECKING\s*:/.test(s)) kind = 'typecheck';
      if (keyword !== 'elif' && keyword !== 'case') lastHeader.set(st.indent, keyword);
      stack.push({ indent: st.indent, kind });

      if (!inScope) {
        const def = /^(?:async\s+)?def\s+(\w+)|^class\s+(\w+)/.exec(s);
        if (def) defined.add((def[1] ?? def[2]) as string);
        const loop = /^(?:async\s+)?for\s+(.+?)\s+in\s/.exec(s);
        if (loop) for (const n of targetNames(loop[1] as string)) defined.add(n);
        if (/^(async\s+)?with\b/.test(s)) {
          for (const m of s.matchAll(/\bas\s+(\(?[\w\s,]+\)?)/g)) {
            for (const n of targetNames((m[1] as string).trim())) defined.add(n);
          }
        }
        const caught = /^except\b.*\bas\s+(\w+)/.exec(s);
        if (caught) defined.add(caught[1] as string);
        // Pattern captures bind names a reader would have to evaluate.
        if (keyword === 'match' || keyword === 'case') dynamic = true;
      }
      if (!inScope && kind !== 'scope') {
        for (const m of s.slice(0, colon).matchAll(/\b([A-Za-z_]\w*)\s*:=/g)) {
          defined.add(m[1] as string);
        }
      }
      body = s.slice(colon + 1).trim();
      // A one-line def or class body is that scope's, not the module's.
      if (!body || kind === 'scope') continue;
    }

    // `global x` inside a function binds x at module scope once it runs.
    const glob = /^global\s+(.+)$/.exec(body);
    if (glob) {
      for (const n of (glob[1] as string).split(','))
        if (IDENT_RE.test(n.trim())) defined.add(n.trim());
      continue;
    }

    const from = /^from\s+(\.*)\s*([\w.]*)\s+import\s+(.+)$/.exec(body);
    if (from) {
      const { names, bound, star } = importNames(from[3] as string);
      if (!inScope) for (const n of bound) defined.add(n);
      if (star) dynamic = true;
      imports.push({
        level: (from[1] as string).length,
        module: from[2] as string,
        names: star ? [] : names,
        star,
        guarded,
        typeOnly,
        start: st.start,
        end: st.end,
      });
      continue;
    }
    const plain = /^import\s+(.+)$/.exec(body);
    if (plain) {
      for (const part of (plain[1] as string).split(',')) {
        const [mod, alias] = part.trim().split(/\s+as\s+/);
        if (!mod || !/^[\w.]+$/.test(mod)) continue;
        if (!inScope) defined.add(alias ? alias.trim() : (mod.split('.')[0] as string));
        imports.push({
          level: 0,
          module: mod,
          names: null,
          star: false,
          guarded,
          typeOnly,
          start: st.start,
          end: st.end,
        });
      }
      continue;
    }

    if (inScope) continue;
    const typeAlias = /^type\s+([A-Za-z_]\w*)\s*[=[]/.exec(body);
    if (typeAlias) defined.add(typeAlias[1] as string);
    if (!/^(return|yield|raise|assert|del|pass|break|continue|await|print)\b/.test(body)) {
      for (const n of assignmentTargets(body)) defined.add(n);
    }
    for (const m of body.matchAll(/\b([A-Za-z_]\w*)\s*:=/g)) defined.add(m[1] as string);

    const all = /^__all__\s*(\+?=)\s*(.*)$/.exec(body);
    if (all) {
      // A literal list of (masked) strings is static; anything else — a
      // concatenation, a comprehension, another module's __all__ — is not.
      if (all[1] === '+=' || !/^[[(][\s'",]*[\])]$/.test((all[2] as string).trim())) dynamic = true;
    }
  }

  if (
    defined.has('__getattr__') ||
    // locals() and vars(x) are left out on purpose: inside a function they read
    // that function's frame, and `vars(args)` is how argparse results are read.
    /(?<![.\w])(globals|exec)\s*\(|(?<![.\w])vars\s*\(\s*\)/.test(masked) ||
    /\bsys\.modules\s*\[\s*__name__\s*\]/.test(masked) ||
    /\b__all__\s*\.\s*(extend|append|insert|__iadd__)\b/.test(masked) ||
    /\b__dict__\s*\.\s*update\b/.test(masked)
  ) {
    dynamic = true;
  }
  return {
    defined,
    imports,
    dynamic,
    pathDynamic: /\b__path__\b/.test(masked),
    aliasesModules:
      /\bsys\.modules\s*\[\s*[rbfuRBFU]*['"][^\]]*\]\s*=(?!=)|\bsys\.modules\.(update|setdefault)\b/.test(
        masked,
      ),
  };
}

// ---------------------------------------------------------------------------
// The snapshot as a module tree

type Resolution =
  { kind: 'module'; file: string } | { kind: 'package'; dir: string; init: string | null };

class PyTree {
  readonly dirs = new Set<string>();
  readonly files: ReadonlySet<string>;

  constructor(paths: Iterable<string>) {
    const files = new Set<string>();
    for (const p of paths) {
      files.add(p);
      const parts = p.split('/');
      for (let k = 1; k < parts.length; k++) this.dirs.add(parts.slice(0, k).join('/'));
    }
    this.files = files;
  }

  static join(dir: string, name: string): string {
    return dir ? `${dir}/${name}` : name;
  }

  isPackageDir(dir: string): boolean {
    return this.files.has(PyTree.join(dir, '__init__.py'));
  }

  /** One segment below a directory: a package wins over a module, as in Python. */
  child(dir: string, name: string): Resolution | null {
    const sub = PyTree.join(dir, name);
    if (this.files.has(`${sub}/__init__.py`))
      return { kind: 'package', dir: sub, init: `${sub}/__init__.py` };
    if (this.files.has(`${sub}.py`)) return { kind: 'module', file: `${sub}.py` };
    if (this.dirs.has(sub)) return { kind: 'package', dir: sub, init: null };
    return null;
  }

  /**
   * Walks a dotted path below `base`. `missingAt` is the index of the first
   * segment that does not exist; `blocked` means a MODULE stood where a package
   * had to be — not provably missing, since a module can set its own __path__.
   */
  walk(
    base: string,
    segments: string[],
  ): { found: Resolution } | { missingAt: number } | { blocked: true } {
    let dir = base;
    let found: Resolution = {
      kind: 'package',
      dir: base,
      init: this.isPackageDir(base) ? PyTree.join(base, '__init__.py') : null,
    };
    for (let k = 0; k < segments.length; k++) {
      if (found.kind === 'module') return { blocked: true };
      const next = this.child(dir, segments[k] as string);
      if (!next) return { missingAt: k };
      found = next;
      if (next.kind === 'package') dir = next.dir;
    }
    return { found };
  }
}

function dirOf(file: string): string {
  const k = file.lastIndexOf('/');
  return k === -1 ? '' : file.slice(0, k);
}

/**
 * Directories Python would search for an absolute import from `file`: the
 * snapshot root, `src/` (the src layout), and the nearest directory above the
 * file that is not itself a package — where a script, or pytest's rootdir
 * insertion, puts its own directory on sys.path.
 */
function absoluteBases(file: string, tree: PyTree): string[] {
  let dir = dirOf(file);
  while (dir && tree.isPackageDir(dir)) dir = dirOf(dir);
  const bases = [dir, ''];
  if (tree.dirs.has('src') && !tree.isPackageDir('src')) bases.push('src');
  return [...new Set(bases)];
}

// ---------------------------------------------------------------------------

/**
 * Phantom symbols and modules across a snapshot's Python files.
 *
 * `complete` has the meaning it has in phantomRefs: a missing MODULE is only
 * reported when the snapshot read was not capped, because in a truncated read
 * the file may be one the reader never reached.
 */
export function pythonPhantomRefs(
  files: readonly { path: string; source: string }[],
  opts: { complete: boolean },
): PhantomRef[] {
  const py = files.filter((f) => PY.test(f.path));
  if (py.length === 0) return [];
  const tree = new PyTree(files.map((f) => f.path));
  const byPath = new Map(py.map((f) => [f.path, f]));
  const modules = new Map<string, PyModule>();
  const read = (path: string): PyModule => {
    let m = modules.get(path);
    if (!m) {
      m = readPythonModule(byPath.get(path)!.source);
      modules.set(path, m);
    }
    return m;
  };
  const builds = files.some(
    (f) =>
      /(^|\/)(setup\.py|.*\.rs|build\.py|.*_build\.py)$/.test(f.path) &&
      EXTENSION_HINT.test(f.source),
  );
  // A package that rewrites sys.modules can make any dotted name under it
  // resolve; none of its missing modules is provable. Keyed by the OUTERMOST
  // package directory, so one aliasing module in `src/a` does not silence
  // `src/b`.
  const topPackage = (dir: string): string => {
    let top = dir;
    for (let d = dir; d && tree.isPackageDir(d); d = dirOf(d)) top = d;
    return top;
  };
  const aliasing = new Set<string>();
  for (const f of py) if (read(f.path).aliasesModules) aliasing.add(topPackage(dirOf(f.path)));

  const out: PhantomRef[] = [];
  for (const file of py) {
    if (FIXTURE_PATH.test(file.path)) continue;
    const mod = read(file.path);
    // Built on first use: most files produce no finding and need no line map.
    let lines: ((offset: number) => number) | null = null;
    const lineOf = (offset: number): number => (lines ??= lineIndex(file.source))(offset);
    const isTest = TEST_PATH.test(file.path);

    for (const imp of mod.imports) {
      if (imp.module === '__future__') continue;
      // `# noqa` on an import is the author telling every linter this line is
      // deliberate — the classic case being a test module that is broken on
      // purpose to exercise an import error.
      const lineEnd = file.source.indexOf('\n', imp.end);
      if (/#\s*noqa\b/i.test(file.source.slice(imp.start, lineEnd === -1 ? undefined : lineEnd))) {
        continue;
      }
      const statement = file.source
        .slice(imp.start, imp.end)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      const segments = imp.module ? imp.module.split('.') : [];
      const shown = `${'.'.repeat(imp.level)}${imp.module}`;

      // Where the import resolves from, or nothing if the repository cannot
      // answer it (the standard library, an installed distribution).
      let bases: string[];
      if (imp.level > 0) {
        let dir = dirOf(file.path);
        let escaped = false;
        for (let k = 1; k < imp.level; k++) {
          if (!dir) {
            escaped = true;
            break;
          }
          dir = dirOf(dir);
        }
        if (escaped) continue;
        bases = [dir];
      } else {
        const first = segments[0] as string;
        if (STDLIB.has(first)) continue;
        bases = absoluteBases(file.path, tree).filter((b) => tree.child(b, first) !== null);
        if (bases.length === 0) continue;
      }

      const walks = bases.map((b) => ({ base: b, result: tree.walk(b, segments) }));
      const found = walks
        .map((w) => ('found' in w.result ? w.result.found : null))
        .filter((r): r is Resolution => r !== null);

      if (found.length === 0) {
        if (walks.some((w) => 'blocked' in w.result)) continue;
        // TYPE_CHECKING imports may name a .pyi-only module, which the
        // snapshot reader does not read.
        if (!opts.complete || imp.guarded || imp.typeOnly || isTest) continue;
        const missing = walks
          .map((w) => ({ base: w.base, at: 'missingAt' in w.result ? w.result.missingAt : -1 }))
          .filter((w) => w.at >= 0);
        // Absolute imports: only when the first segment is a REAL package or
        // module here. A bare directory that happens to share a third-party
        // name (`examples/flask/`) is no evidence of what `flask.views` is.
        const provable = missing.filter((w) => {
          if (imp.level > 0) return w.at >= 0;
          if (w.at === 0) return false;
          const head = tree.child(w.base, segments[0] as string);
          return head?.kind === 'module' || (head?.kind === 'package' && head.init !== null);
        });
        if (provable.length === 0) continue;
        const { base, at } = provable[0] as { base: string; at: number };
        const name = segments[at] as string;
        const wouldBe = PyTree.join(base, segments.slice(0, at + 1).join('/'));
        if (GENERATED_MODULE.test(name)) continue;
        if (builds && name.startsWith('_')) continue;
        if (UNREAD_SEGMENT.test(wouldBe)) continue;
        if (aliasing.has(topPackage(dirOf(wouldBe)))) continue;
        // A package that edits its own __path__ can find submodules anywhere.
        const parentInit = PyTree.join(dirOf(`${wouldBe}.py`), '__init__.py');
        if (byPath.has(parentInit) && read(parentInit).pathDynamic) continue;
        out.push({
          ruleId: PHANTOM_MODULE_RULE_ID,
          file: file.path,
          line: lineOf(imp.start),
          specifier: shown,
          name: null,
          statement,
          message:
            `${shown} does not resolve to any module in the repository: there is no ` +
            `${wouldBe}.py and no ${wouldBe}/ package. Python fails this import at load time, ` +
            'on the first request that touches the module.',
        });
        continue;
      }

      if (!imp.names || imp.names.length === 0 || imp.typeOnly) continue;
      // Two places Python might load it from, and they disagree: which one
      // runs depends on how the program is started.
      const targets = new Set(found.map((r) => (r.kind === 'module' ? r.file : r.dir)));
      if (targets.size !== 1) continue;
      const target = found[0] as Resolution;
      const targetFile = target.kind === 'module' ? target.file : target.init;
      // A namespace package (no __init__.py) has submodules and nothing else.
      const surface = targetFile && byPath.has(targetFile) ? read(targetFile) : null;
      if (targetFile && !surface) continue;
      if (surface?.dynamic) continue;

      const missing = imp.names.filter((name) => {
        if (INTRINSIC.has(name) || surface?.defined.has(name)) return false;
        // `from pkg import sub` imports the submodule when pkg has no such name.
        if (target.kind === 'package' && tree.child(target.dir, name)) return false;
        return true;
      });
      if (missing.length === 0) continue;
      const where = targetFile ?? `${target.kind === 'package' ? target.dir : ''}/`;
      out.push({
        ruleId: PHANTOM_SYMBOL_RULE_ID,
        file: file.path,
        line: lineOf(imp.start),
        specifier: shown,
        name: missing.join(', '),
        statement,
        message:
          `${file.path} imports ${missing.map((n) => `"${n}"`).join(', ')} from ${shown}, and ` +
          `${where} defines no such ${missing.length === 1 ? 'name' : 'names'}` +
          `${target.kind === 'package' ? ' and has no such submodule' : ''}. Python raises ` +
          'ImportError when this module is loaded.',
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
