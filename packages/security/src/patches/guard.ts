// The error-handling guard for model-drafted patches (W22-09, 2026-10-30).
//
// WHY. The re-scan (verify.ts) proves that a rule stopped firing and that no
// other rule started. It cannot see behaviour. On outline a draft for
// bpm-ch-silent-fallback-return deleted the try/catch around ProseMirror's
// `view.posAtDOM()` — which throws for positions outside the document — so a
// function that returned null now threw inside editor drag handling. The rule
// was satisfied and no rule fired, so it was "verified". A lint hit is never
// worth a crash: a patch that takes error handling away, or adds a
// force-unwrap, is rejected before the re-scan runs.
//
// HOW. A deliberately plain heuristic, per language family, over the file
// before and after the patch:
//
//   - "handler sites" are the catching side of error handling (a `catch`, an
//     `except`, a `rescue`, `if err != nil`, Rust's `?`, Swift's `try?` ...).
//     The patch is rejected when the patched file has FEWER of them than the
//     original. Counting the whole file is the same as counting the diff's
//     removed and added lines (unchanged lines count on both sides), so a
//     handler the patch moves, rewrites or adds is fine; only a net loss is not.
//   - "force sites" are constructs that crash on the failure path (`.unwrap()`,
//     `!!`, `try!`, `as!`, a postfix force-unwrap, Go's `panic(`). The patch is
//     rejected when the patched file has MORE of them.
//
// Strings and line comments are blanked first, so a log message that says
// "catch" counts for nothing. Files of a language not listed here are not
// checked: the guard only says no where it understands the language.

export type PatchGuardCode = 'removes_error_handling' | 'adds_force_unwrap';

export type PatchGuardResult = { ok: true } | { ok: false; code: PatchGuardCode; reason: string };

interface Marker {
  /** How the reason names it. */
  label: string;
  /** Global regex; each match is one site. */
  re: RegExp;
}

interface Family {
  name: string;
  comment: '//' | '#' | 'both';
  /** Rust: single quotes are char literals or lifetimes, never strings. */
  singleQuoteIsChar?: boolean;
  handlers: Marker[];
  forced: Marker[];
}

// A postfix force-unwrap: `x!.y`, `f()!)`, `a[0]! + 1`. Not `!=`, not prefix
// negation, not Swift's `try!` / `as!` (counted on their own).
const POSTFIX_BANG = /(?<=[\w)\]])(?<!\btry)(?<!\bas)!(?=[.)\],;:\s]|$)/g;
// TypeScript's non-null assertion, more narrowly: followed by `.`, `)`, `]`,
// `,` or `;` only, so JSX text such as `Saved! ` does not count.
const NON_NULL_ASSERTION = /(?<=[\w)\]])!(?=[.)\],;])/g;

const CATCH: Marker = { label: 'catch', re: /\bcatch\b/g };

const JS: Family = { name: 'JavaScript', comment: '//', handlers: [CATCH], forced: [] };
const TS: Family = {
  name: 'TypeScript',
  comment: '//',
  handlers: [CATCH],
  forced: [{ label: 'a non-null assertion (x!)', re: NON_NULL_ASSERTION }],
};
const PYTHON: Family = {
  name: 'Python',
  comment: '#',
  handlers: [
    { label: 'except', re: /\bexcept\b/g },
    { label: 'suppress(...)', re: /\bsuppress\s*\(/g },
  ],
  forced: [],
};
const GO: Family = {
  name: 'Go',
  comment: '//',
  handlers: [
    { label: 'if err != nil', re: /\b\w*[eE]rr\w*\s*!=\s*nil\b/g },
    { label: 'recover()', re: /\brecover\s*\(\s*\)/g },
  ],
  forced: [{ label: 'panic(...)', re: /\bpanic\s*\(/g }],
};
const RUST: Family = {
  name: 'Rust',
  comment: '//',
  singleQuoteIsChar: true,
  handlers: [
    { label: 'the ? operator', re: /[\w)\]>]\?/g },
    // A match arm or `if let` on the error — not `return Err(e)`, which makes one.
    { label: 'an Err(...) arm', re: /\bErr\s*\([^()]*\)\s*=>|\blet\s+Err\s*\(/g },
    { label: 'unwrap_or...', re: /\.unwrap_or(?:_else|_default)?\s*\(/g },
    { label: 'catch_unwind', re: /\bcatch_unwind\b/g },
  ],
  forced: [
    { label: '.unwrap()', re: /\.unwrap\s*\(\s*\)/g },
    { label: '.expect(...)', re: /\.expect\s*\(/g },
    { label: '.unwrap_unchecked()', re: /\.unwrap_unchecked\s*\(/g },
    { label: 'panic!', re: /\bpanic!\s*[([{]/g },
  ],
};
// Java, C#, C++, Scala, Dart, PHP: try/catch languages without a force operator
// worth matching.
const CATCH_FAMILY: Family = { name: 'try/catch', comment: '//', handlers: [CATCH], forced: [] };
const PHP: Family = { ...CATCH_FAMILY, name: 'PHP', comment: 'both' };
const KOTLIN: Family = {
  name: 'Kotlin',
  comment: '//',
  handlers: [CATCH, { label: 'runCatching', re: /\brunCatching\b/g }],
  forced: [{ label: '!!', re: /!!/g }],
};
const RUBY: Family = {
  name: 'Ruby',
  comment: '#',
  handlers: [{ label: 'rescue', re: /\brescue\b/g }],
  forced: [],
};
const SWIFT: Family = {
  name: 'Swift',
  comment: '//',
  handlers: [CATCH, { label: 'try?', re: /\btry\?/g }],
  forced: [
    { label: 'try!', re: /\btry!/g },
    { label: 'as!', re: /\bas!/g },
    { label: 'a force-unwrap (x!)', re: POSTFIX_BANG },
  ],
};

const BY_EXTENSION: Record<string, Family> = {
  js: JS,
  jsx: JS,
  mjs: JS,
  cjs: JS,
  ts: TS,
  tsx: TS,
  mts: TS,
  cts: TS,
  py: PYTHON,
  pyi: PYTHON,
  go: GO,
  rs: RUST,
  java: CATCH_FAMILY,
  cs: CATCH_FAMILY,
  cpp: CATCH_FAMILY,
  cc: CATCH_FAMILY,
  cxx: CATCH_FAMILY,
  hpp: CATCH_FAMILY,
  scala: CATCH_FAMILY,
  dart: CATCH_FAMILY,
  php: PHP,
  kt: KOTLIN,
  kts: KOTLIN,
  rb: RUBY,
  swift: SWIFT,
};

/** The language family the guard checks `file` as, or null when it does not check it. */
export function guardFamily(file: string): string | null {
  return familyOf(file)?.name ?? null;
}

function familyOf(file: string): Family | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
  return ext ? (BY_EXTENSION[ext] ?? null) : null;
}

/** One line with string literals and its trailing comment blanked out. */
function code(line: string, family: Family): string {
  let out = line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(
      family.singleQuoteIsChar ? /'(?:\\.|[^'\\])'/g : /'(?:\\.|[^'\\])*'/g,
      family.singleQuoteIsChar ? "' '" : "''",
    )
    .replace(/\/\*.*?\*\//g, ' ');
  if (family.comment !== '#') out = out.replace(/\/\/.*$/, '');
  if (family.comment !== '//') out = out.replace(/#.*$/, '');
  // Inside a block comment or doc comment.
  if (family.comment !== '#' && /^\s*(?:\/\*|\*(?:\s|\/|$))/.test(out)) return '';
  return out;
}

function count(text: string, family: Family, markers: readonly Marker[]): Map<string, number> {
  const counts = new Map<string, number>(markers.map((m) => [m.label, 0]));
  for (const raw of text.split('\n')) {
    const line = code(raw, family);
    if (line.trim() === '') continue;
    for (const m of markers) {
      const n = line.match(m.re)?.length ?? 0;
      if (n > 0) counts.set(m.label, counts.get(m.label)! + n);
    }
  }
  return counts;
}

const sum = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

const list = (labels: readonly string[]): string =>
  labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)!}`;

/**
 * Rejects a patch that takes error handling away or adds a crash path.
 *
 * `before` and `after` are the whole file; see the header for why counting the
 * whole file is counting the diff.
 */
export function checkErrorHandling(args: {
  file: string;
  before: string;
  after: string;
}): PatchGuardResult {
  const family = familyOf(args.file);
  if (!family) return { ok: true };

  const hb = count(args.before, family, family.handlers);
  const ha = count(args.after, family, family.handlers);
  if (sum(ha) < sum(hb)) {
    const lost = family.handlers
      .filter((m) => (ha.get(m.label) ?? 0) < (hb.get(m.label) ?? 0))
      .map((m) => m.label);
    return {
      ok: false,
      code: 'removes_error_handling',
      reason: `The patch removes error handling (${list(lost)}) without adding an equivalent handler, so code that handled a failure before could now throw or crash; a fix may add to error handling but never take it away.`,
    };
  }

  const fb = count(args.before, family, family.forced);
  const fa = count(args.after, family, family.forced);
  const added = family.forced
    .filter((m) => (fa.get(m.label) ?? 0) > (fb.get(m.label) ?? 0))
    .map((m) => m.label);
  if (added.length > 0) {
    return {
      ok: false,
      code: 'adds_force_unwrap',
      reason: `The patch adds ${list(added)}, which crashes when the value is missing or the call fails; a fix must handle that case instead.`,
    };
  }
  return { ok: true };
}
