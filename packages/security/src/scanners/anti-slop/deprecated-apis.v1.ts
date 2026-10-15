import type { Language } from './leftovers-lex.js';

// The deprecated-API table, version 1 (W18-07).
//
// APIs that models keep writing because their training data predates the
// deprecation. Every entry cites the OFFICIAL notice — the runtime's own
// deprecation list, changelog or API reference — because "deprecated" is a
// claim about someone else's project, and a finding that says so has to be
// able to show where they said it.
//
// VERSIONED, NOT EDITED IN PLACE. A finding records which table produced it
// (`DEPRECATED_API_TABLE_VERSION`); adding or removing an entry is a v2 so a
// count that moves between two scans can be told apart from code that moved.
//
// Patterns run over code with comments blanked and strings KEPT (an import
// specifier is a string), and a match must START in code — so
// `"new Buffer("` in a log message or `// fs.exists(` in a note never match.

export const DEPRECATED_API_TABLE_VERSION = 'deprecated-apis.v1';

export interface DeprecatedApi {
  /** Stable within this table version. */
  id: string;
  language: Language;
  /** Matched against comment-blanked source; the match must start in code. */
  pattern: RegExp;
  /** The file must also match this (an import of the module), or the entry is skipped. */
  requires?: RegExp;
  /**
   * The replacement within this many lines means a compatibility branch
   * (`Buffer.from ? Buffer.from(x) : new Buffer(x)`), which is deliberate.
   */
  compat?: RegExp;
  /** Judged per match, beyond the pattern — see `deprecated-apis.ts`. */
  judge?: 'outside_running_loop';
  replacement: string;
  /** The official deprecation notice. */
  source: string;
}

const NODE_FS =
  /(?:require\s*\(\s*['"](?:node:)?fs['"]\s*\)|from\s+['"](?:node:)?fs['"]|import\s+\*\s+as\s+fs\b)/;
const NODE_URL = /(?:require\s*\(\s*['"](?:node:)?url['"]\s*\)|from\s+['"](?:node:)?url['"])/;
const NODE_CRYPTO =
  /(?:require\s*\(\s*['"](?:node:)?crypto['"]\s*\)|from\s+['"](?:node:)?crypto['"])/;
const REACT = /(?:from\s+['"]react['"]|require\s*\(\s*['"]react['"]\s*\))/;
const REACT_DOM = /(?:from\s+['"]react-dom['"]|require\s*\(\s*['"]react-dom['"]\s*\))/;
const PY_DATETIME = /^\s*(?:import\s+datetime\b|from\s+datetime\s+import\b)/m;
const PY_ASYNCIO = /^\s*(?:import\s+asyncio\b|from\s+asyncio\s+import\b)/m;
const PY_COLLECTIONS = /^\s*import\s+collections\b/m;
const GO_IOUTIL = /"io\/ioutil"/;

export const DEPRECATED_APIS: readonly DeprecatedApi[] = [
  // ---- Node.js ---------------------------------------------------------
  {
    id: 'node.buffer_constructor',
    language: 'js',
    pattern: /\bnew\s+Buffer\s*\(/g,
    compat: /\bBuffer\.(?:from|alloc|allocUnsafe)\b/,
    replacement: 'Buffer.from(), Buffer.alloc() or Buffer.allocUnsafe()',
    source: 'https://nodejs.org/api/deprecations.html#DEP0005',
  },
  {
    id: 'node.fs_exists',
    language: 'js',
    pattern: /\bfs\.exists\s*\(/g,
    requires: NODE_FS,
    replacement: 'fs.existsSync(), or fs.stat()/fs.access() and handle the error',
    source: 'https://nodejs.org/api/deprecations.html#DEP0034',
  },
  {
    id: 'node.url_parse',
    language: 'js',
    pattern: /\burl\.parse\s*\(/g,
    requires: NODE_URL,
    compat: /\bnew\s+URL\s*\(/,
    replacement: 'the WHATWG URL API: new URL(input, base)',
    source: 'https://nodejs.org/api/deprecations.html#DEP0169',
  },
  {
    id: 'node.crypto_create_cipher',
    language: 'js',
    pattern: /\bcreate(?:Cipher|Decipher)\s*\(/g,
    requires: NODE_CRYPTO,
    replacement: 'crypto.createCipheriv() / createDecipheriv() with a random IV',
    source: 'https://nodejs.org/api/deprecations.html#DEP0106',
  },
  {
    id: 'node.domain_module',
    language: 'js',
    pattern:
      /(?:\brequire\s*\(\s*['"](?:node:)?domain['"]\s*\)|\bfrom\s+['"](?:node:)?domain['"]|\bimport\s+['"](?:node:)?domain['"])/g,
    replacement: 'AsyncLocalStorage for context; explicit error handling for errors',
    source: 'https://nodejs.org/api/deprecations.html#DEP0032',
  },
  {
    id: 'npm.request',
    language: 'js',
    pattern: /(?:\brequire\s*\(\s*['"]request['"]\s*\)|\bfrom\s+['"]request['"])/g,
    replacement: 'fetch (built into Node 18+), undici, or got',
    source: 'https://github.com/request/request/issues/3142',
  },
  // ---- React -----------------------------------------------------------
  {
    id: 'react.legacy_lifecycle',
    language: 'js',
    // A method or class-field DEFINITION — React's own warning code reads
    // these names off instances, and that is not a component using them.
    pattern:
      /^[ \t]*(?:async\s+)?(?:componentWillMount|componentWillReceiveProps|componentWillUpdate)\s*(?:\(|=)/gm,
    requires: REACT,
    replacement: 'componentDidMount / getDerivedStateFromProps / componentDidUpdate (or hooks)',
    source: 'https://legacy.reactjs.org/blog/2018/03/27/update-on-async-rendering.html',
  },
  {
    id: 'react.dom_render',
    language: 'js',
    pattern: /\bReactDOM\.(?:render|hydrate)\s*\(/g,
    compat: /\bcreateRoot\b|\bhydrateRoot\b/,
    replacement: "createRoot(container).render(element) from 'react-dom/client'",
    source:
      'https://react.dev/blog/2022/03/08/react-18-upgrade-guide#updates-to-client-rendering-apis',
  },
  {
    id: 'react.dom_render_import',
    language: 'js',
    pattern:
      /\bimport\s*\{[^}]*\b(?:render|hydrate)\b(?!\s*as\b)[^}]*\}\s*from\s*['"]react-dom['"]/g,
    replacement: "createRoot(container).render(element) from 'react-dom/client'",
    source:
      'https://react.dev/blog/2022/03/08/react-18-upgrade-guide#updates-to-client-rendering-apis',
  },
  {
    id: 'react.find_dom_node',
    language: 'js',
    pattern: /\bfindDOMNode\s*\(/g,
    requires: REACT_DOM,
    replacement: 'a ref (useRef / createRef) on the DOM element',
    source: 'https://react.dev/reference/react-dom/findDOMNode',
  },
  // ---- Python ----------------------------------------------------------
  {
    id: 'python.datetime_utcnow',
    language: 'python',
    pattern: /\bdatetime\.(?:utcnow|utcfromtimestamp)\s*\(/g,
    requires: PY_DATETIME,
    replacement: 'datetime.now(timezone.utc) / datetime.fromtimestamp(ts, timezone.utc)',
    source: 'https://docs.python.org/3/library/datetime.html#datetime.datetime.utcnow',
  },
  {
    id: 'python.asyncio_get_event_loop',
    language: 'python',
    pattern: /\basyncio\.get_event_loop\s*\(\s*\)/g,
    requires: PY_ASYNCIO,
    compat: /\bget_running_loop\s*\(/,
    judge: 'outside_running_loop',
    replacement: 'asyncio.run() at the entry point; asyncio.get_running_loop() inside a coroutine',
    source: 'https://docs.python.org/3/library/asyncio-eventloop.html#asyncio.get_event_loop',
  },
  {
    id: 'python.imp_module',
    language: 'python',
    pattern: /^[ \t]*(?:import\s+imp\s*(?:$|,|\bas\b)|from\s+imp\s+import\b)/gm,
    compat: /\bimportlib\b/,
    replacement: 'importlib (removed from the standard library in Python 3.12)',
    source: 'https://docs.python.org/3/whatsnew/3.12.html#imp',
  },
  {
    id: 'python.distutils',
    language: 'python',
    pattern: /^[ \t]*(?:import\s+distutils\b|from\s+distutils\b)/gm,
    compat: /\bsetuptools\b|\bsysconfig\b|\bshutil\.which\b|\bpackaging\b/,
    replacement: 'setuptools, packaging, sysconfig or shutil (PEP 632; removed in Python 3.12)',
    source: 'https://peps.python.org/pep-0632/',
  },
  {
    id: 'python.pkg_resources',
    language: 'python',
    pattern: /^[ \t]*(?:import\s+pkg_resources\b|from\s+pkg_resources\s+import\b)/gm,
    compat: /\bimportlib(?:_|\.)(?:metadata|resources)\b/,
    replacement: 'importlib.metadata / importlib.resources',
    source: 'https://setuptools.pypa.io/en/latest/pkg_resources.html',
  },
  {
    id: 'python.collections_abc_alias',
    language: 'python',
    pattern:
      /\bcollections\.(?:Mapping|MutableMapping|Sequence|MutableSequence|Iterable|Iterator|Callable|Set|MutableSet|Hashable|Sized|Container)\b/g,
    requires: PY_COLLECTIONS,
    replacement: 'collections.abc.<Name> (the aliases were removed in Python 3.10)',
    source: 'https://docs.python.org/3/whatsnew/3.10.html#removed',
  },
  {
    id: 'python.logging_warn',
    language: 'python',
    // Not `log.warn`: distutils.log and many third-party loggers define
    // `warn` as their real API, and the receiver's type is not in the text.
    pattern: /\b(?:logging|logger|LOGGER|_logger)\.warn\s*\(/g,
    requires: /^\s*(?:import\s+logging\b|from\s+logging\s+import\b)/m,
    replacement: '.warning()',
    source: 'https://docs.python.org/3/library/logging.html#logging.Logger.warning',
  },
  // ---- Java ------------------------------------------------------------
  {
    id: 'java.boxing_constructor',
    language: 'java',
    pattern: /\bnew\s+(?:Integer|Long|Short|Byte|Double|Float|Boolean|Character)\s*\(/g,
    replacement: 'valueOf() or autoboxing (deprecated for removal, JEP 390)',
    source: 'https://openjdk.org/jeps/390',
  },
  {
    id: 'java.thread_stop',
    language: 'java',
    // The receiver has to read as a thread: `.stop()` alone is every
    // server, timer and media player in the codebase.
    pattern:
      /\b(?:Thread\.currentThread\(\)|[\w$]*[Tt]hread[\w$]*)\.(?:stop|suspend|resume)\s*\(\s*\)/g,
    replacement: 'cooperative cancellation: interrupt() and a checked flag',
    source:
      'https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html#stop()',
  },
  // ---- Go --------------------------------------------------------------
  {
    id: 'go.ioutil',
    language: 'go',
    pattern:
      /\bioutil\.(?:ReadAll|ReadFile|WriteFile|ReadDir|TempDir|TempFile|NopCloser|Discard)\b/g,
    requires: GO_IOUTIL,
    replacement: 'the same functions in io and os (deprecated since Go 1.16)',
    source: 'https://pkg.go.dev/io/ioutil',
  },
];
