import {
  CODE,
  CONVENTIONAL_NAMES,
  ENTRY_FILE,
  IDENT,
  isSurfaced,
  lineAt,
  looksMinified,
  maskSource,
  PUBLIC_SURFACE,
  surfacedBy,
  TEST_OR_FIXTURE,
} from './source-graph.js';
import {
  braceDepths,
  classesOf,
  closeAngle,
  functionAt,
  prevNonWs,
  skipWs,
  splitTopLevel,
  type FunctionSite,
} from './signatures.js';

// Delegation-only wrappers (W18-05, CODE_HEALTH_SUITE.md §1 R-06).
//
// A function whose whole body is `return other(a, b)` with exactly its own
// parameters, in order, unchanged. It adds a name and a jump and nothing else.
// Until now only the T2 checklist could see it; it is a shape, so it is ours.
//
// "ADDS NOTHING" IS THE WHOLE TEST, and most of this file is the list of things
// a thin-looking wrapper can add that a pattern would miss:
//
//   - async, or `return await`: the result becomes a promise, and a rejection
//     is attributed to this frame.
//   - Defaults, destructuring, a dropped or reordered argument, a literal.
//   - Arity truncation. `const toInt = (s) => parseInt(s)` exists so that
//     `.map(toInt)` does NOT hand parseInt the index as a radix. Any wrapper
//     its repository uses as a VALUE (passed, stored, bound) rather than called
//     is skipped for that reason, and for `this` binding.
//   - `this` and `super`: a method forwarding to `this.inner.x(a)` is
//     composition, and one in a class that extends or implements anything is an
//     override or an adapter honouring a contract. Methods are read only in
//     classes with no heritage, and only when they forward to a free function.
//   - Overloads, decorators (`@Get() find(id)` is a route), `@deprecated`
//     shims kept for callers, framework names (`handler`, `GET`, `loader`).
//
// PUBLIC SURFACE, decided on evidence (see plan.json W18-05): an alias in an
// index file, or exported under a name an index file mentions, is how a
// package renames its API without breaking consumers — a finding there is a
// request to break them. Exported wrappers elsewhere are still reported;
// within a repository they are as thin as unexported ones.

export const DELEGATION_WRAPPER_RULE_ID = 'slop.delegation_wrapper';

export interface DelegationWrapper {
  ruleId: typeof DELEGATION_WRAPPER_RULE_ID;
  file: string;
  name: string;
  line: number;
  /** What it forwards to: `inner.fetchUser`. */
  callee: string;
  /** The declaration's first line, verbatim — the evidence quote. */
  declaration: string;
  message: string;
}

const CALLEE = `${IDENT}(?:\\s*\\.\\s*${IDENT})*`;
const BLOCK_BODY = new RegExp(`^return\\s+(${CALLEE})\\s*\\(([^()]*)\\)\\s*;?$`);
const EXPR_BODY = new RegExp(`^(${CALLEE})\\s*\\(([^()]*)\\)`);
/** Callee roots that are not "another function": keywords, binding, loaders. */
const NOT_A_CALLEE = new Set([
  'this',
  'super',
  'import',
  'require',
  'new',
  'typeof',
  'await',
  'void',
  'yield',
  'delete',
  'async',
]);
/** After an expression body's call, a character that continues the expression. */
const CONTINUES = /[.?[(+\-*/%&|^<>=!:`]/;

/** Is `index` the start of a statement — not an argument or an operand? */
function statementStart(text: string, index: number): boolean {
  const p = prevNonWs(text, index);
  if (p < 0) return true;
  const prev = text[p] as string;
  if (';{}'.includes(prev)) return true;
  // No-semicolon style: a new line after a finished expression.
  return text.slice(p, index).includes('\n') && !/[(,=:?[|&!+\-*/<>.]/.test(prev);
}

/** The comment and decorator lines directly above `line` (1-based), joined. */
function leadingLines(lines: string[], line: number): string {
  const out: string[] = [];
  for (let k = line - 2; k >= 0; k--) {
    const text = (lines[k] as string).trim();
    if (/^(\/\/|\/\*|\*|@)/.test(text)) out.push(text);
    else break;
  }
  return out.join('\n');
}

/** Does an expression body end at the call, or does the expression go on? */
function endsAfter(text: string, close: number): boolean {
  const next = skipWs(text, close + 1);
  if (next >= text.length) return true;
  const c = text[next] as string;
  if (';}),'.includes(c)) return true;
  return text.slice(close + 1, next).includes('\n') && !CONTINUES.test(c);
}

/** The callee and argument list a site's body forwards to, or null. */
function forwarded(text: string, site: FunctionSite): { callee: string; args: string } | null {
  if (site.body.kind === 'block') {
    const m = BLOCK_BODY.exec(text.slice(site.body.start + 1, site.body.end).trim());
    return m ? { callee: m[1] as string, args: m[2] as string } : null;
  }
  if (site.body.kind === 'expr') {
    const m = EXPR_BODY.exec(text.slice(site.body.start, site.body.start + 400));
    if (!m) return null;
    if (!endsAfter(text, site.body.start + m[0].length - 1)) return null;
    return { callee: m[1] as string, args: m[2] as string };
  }
  return null;
}

/** Is this site a pure forward of its own parameters? Returns the callee. */
function delegates(text: string, site: FunctionSite): string | null {
  if (!site.name || site.isAsync || site.generator) return null;
  if (CONVENTIONAL_NAMES.has(site.name)) return null;
  // Zero parameters: `() => compute()` is a thunk — laziness is the point.
  if (site.params.length === 0) return null;
  const names: string[] = [];
  for (const [k, p] of site.params.entries()) {
    if (p.name === null || p.hasDefault || p.decorated) return null;
    if (p.rest && k !== site.params.length - 1) return null;
    names.push(`${p.rest ? '...' : ''}${p.name}`);
  }
  const fwd = forwarded(text, site);
  if (!fwd) return null;
  const callee = fwd.callee.replace(/\s+/g, '');
  const root = callee.split('.')[0] as string;
  if (NOT_A_CALLEE.has(root) || callee === site.name) return null;
  // `fn.call(a)` makes `a` the receiver: that is a change, not a forward.
  if (/\.(call|apply|bind)$/.test(callee)) return null;
  // A parameter as the callee (`(fn, a) => fn(a)`) is a combinator, and its
  // own parameters cannot all be forwarded anyway.
  if (site.params.some((p) => p.name === root)) return null;
  const args = splitTopLevel(fwd.args).map((a) => a.replace(/\s+/g, ''));
  if (args.length !== names.length || args.some((a, k) => a !== names[k])) return null;
  return callee;
}

/** Ranges of `import … from` and `export { … }` clauses: plumbing, not uses. */
function plumbing(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/\bimport\b[^;'"`]*?\bfrom\b|\bexport\s+(?:type\s+)?\{[^}]*\}/g)) {
    out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return out;
}

interface Corpus {
  path: string;
  masked: string;
  plumbing: [number, number][];
}

/**
 * Is `name` used anywhere as a value — passed, stored, bound — rather than
 * called? `member` reads `.name` occurrences (a method) instead of bare ones.
 */
function usedAsValue(
  corpus: Corpus[],
  name: string,
  member: boolean,
  declaration: { file: string; at: number },
): boolean {
  const escaped = name.replace(/\$/g, '\\$');
  const re = member
    ? new RegExp(`(?<=\\.\\s*)${escaped}(?![\\w$])`, 'g')
    : new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, 'g');
  for (const c of corpus) {
    for (const m of c.masked.matchAll(re)) {
      const at = m.index ?? 0;
      if (c.path === declaration.file && at === declaration.at) continue;
      if (c.plumbing.some(([from, to]) => at >= from && at < to)) continue;
      let next = skipWs(c.masked, at + name.length);
      if (c.masked[next] === '<') {
        const end = closeAngle(c.masked, next);
        if (end !== -1) next = skipWs(c.masked, end + 1);
      }
      if (c.masked[next] !== '(') return true;
    }
  }
  return false;
}

/**
 * Is `name` a variable of this file — a `const`/`let`/`var` that is not a
 * `require`, or a parameter of some function in it?
 *
 * `get(k) { return registry.get(k); }` over a module's private Map, or
 * `(n) => programPath.scope.hasBinding(n)` over a closure, is the only way in
 * to state the wrapper's caller cannot reach. That is encapsulation, not a
 * layer. Parameters are matched loosely, which skips more, never less.
 */
function stateBinding(text: string, name: string): boolean {
  const n = name.replace(/\$/g, '\\$');
  const variable = new RegExp(
    `(?<![\\w$.])(?:const|let|var)\\s+${n}\\s*(?::[^=;]*)?=(?!=)(?!\\s*(?:require\\s*\\(|await\\s+import\\s*\\())`,
  );
  if (variable.test(text)) return true;
  if (new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${n}\\s*[;,\\n]`).test(text)) return true;
  return new RegExp(`[(,]\\s*${n}\\s*[,):?]`).test(text);
}

/** The sites a file declares: top-level-shaped functions, and methods of plain classes. */
function sitesOf(
  text: string,
  extended: ReadonlySet<string>,
): { site: FunctionSite; member: boolean }[] {
  const out: { site: FunctionSite; member: boolean }[] = [];
  const decl =
    /(?<![\w$.])(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b|(?<![\w$.])(?:export\s+)?(?:const|let|var)\s+/g;
  for (const m of text.matchAll(decl)) {
    const at = m.index ?? 0;
    if (!statementStart(text, at)) continue;
    const site = functionAt(text, at);
    if (site) out.push({ site, member: false });
  }

  const depths = braceDepths(text);
  for (const cls of classesOf(text)) {
    // A class with heritage overrides or honours a contract; an exported or
    // extended one is somebody's base, and its methods are hooks to override.
    if (cls.abstract || cls.extends !== null || cls.implements.length > 0) continue;
    if (cls.exported || !cls.name || extended.has(cls.name)) continue;
    // CommonJS: `module.exports = { LegacyESLint }`, `exports.Foo = Foo`.
    if (new RegExp(`\\b(?:module\\.)?exports\\b[^;]*(?<![\\w$])${cls.name}(?![\\w$])`).test(text))
      continue;
    const inner = (depths[cls.bodyStart] ?? 0) + 1;
    const body = text.slice(cls.bodyStart + 1, cls.bodyEnd);
    for (const m of body.matchAll(/(^|[\n;{}])[ \t]*(?=[A-Za-z_$*])/g)) {
      const at = cls.bodyStart + 1 + (m.index ?? 0) + (m[1] as string).length;
      if (depths[at] !== inner) continue;
      const site = functionAt(text, at, true);
      if (site?.kind !== 'method') continue;
      if (
        /\b(protected|abstract|override)\b/.test(
          text.slice(at, site.index + 80).split('(')[0] as string,
        )
      ) {
        continue;
      }
      out.push({ site, member: true });
    }
  }
  return out;
}

/** Delegation-only wrappers in a set of files. Sorted by file and line. */
export function delegationWrappers(
  files: readonly { path: string; source: string }[],
): DelegationWrapper[] {
  const code = files.filter((f) => CODE.test(f.path));
  const corpus: Corpus[] = code.map((f) => {
    const masked = maskSource(f.source);
    return { path: f.path, masked, plumbing: plumbing(masked) };
  });
  const entryText = corpus.filter((c) => ENTRY_FILE.test(c.path)).map((c) => c.masked);
  const surfaced = surfacedBy(code.map((f, k) => ({ ...f, masked: (corpus[k] as Corpus).masked })));
  // Classes something extends: their methods are override hooks.
  const extended = new Set<string>();
  for (const c of corpus)
    for (const cls of classesOf(c.masked)) if (cls.extends) extended.add(cls.extends);
  const out: DelegationWrapper[] = [];

  for (const [k, file] of code.entries()) {
    if (
      PUBLIC_SURFACE.some((re) => re.test(file.path)) ||
      TEST_OR_FIXTURE.test(file.path) ||
      looksMinified(file.path, file.source)
    ) {
      // Routes, scripts and configs ARE in PUBLIC_SURFACE; a wrapper there is
      // usually the framework's adapter.
      continue;
    }
    const { masked } = corpus[k] as Corpus;
    const lines = file.source.split('\n');
    const sites = sitesOf(masked, extended);

    // Overloads: the same name declared more than once in a file — the
    // bodiless signatures are sites too.
    const seen = new Map<string, number>();
    for (const { site } of sites) seen.set(site.name, (seen.get(site.name) ?? 0) + 1);

    for (const { site, member } of sites) {
      const callee = delegates(masked, site);
      if (!callee) continue;
      if ((seen.get(site.name) ?? 0) > 1) continue;
      const line = lineAt(masked, site.index);
      if (/deprecated/i.test(leadingLines(lines, line))) continue;
      if (/^\s*@/.test(lines[line - 2] ?? '')) continue;
      const nameRe = new RegExp(`(?<![\\w$])${site.name.replace(/\$/g, '\\$')}(?![\\w$])`);
      if (site.exported && entryText.some((t) => nameRe.test(t))) continue;
      if (site.exported && isSurfaced(surfaced, site.name, file.path)) continue;
      if (callee.includes('.') && stateBinding(masked, callee.split('.')[0] as string)) continue;
      const declaredAt = site.index + masked.slice(site.index).search(nameRe);
      if (usedAsValue(corpus, site.name, member, { file: file.path, at: declaredAt })) continue;

      out.push({
        ruleId: DELEGATION_WRAPPER_RULE_ID,
        file: file.path,
        name: site.name,
        line,
        callee,
        declaration: (lines[line - 1] ?? '').trim(),
        message:
          `${site.name} only forwards its own parameters, unchanged and in order, to ${callee} ` +
          'and returns the result. It adds a name and a jump and nothing else; call ' +
          `${callee} directly, or give the wrapper something to do.`,
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
