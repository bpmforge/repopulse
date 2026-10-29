import { maskPython, maskSource } from '../scanners/anti-slop/source-graph.js';
import { maskGo } from '../scanners/anti-slop/go-graph.js';
import { maskRust } from '../scanners/anti-slop/rust-graph.js';
import type { DefinitionKind } from '../triage/packet.js';

// Lexical reading of one source file for evidence capture (W22-02 slice 1).
//
// Not an index and not a parser: it answers three questions about ONE hit, on
// the masked text (comments and string contents blanked, offsets kept) the
// in-process checks already share — which function encloses this line, which
// names does the line use, and where in this file is each of them declared.
// Lodestone's tree-sitter index replaces the guesswork here when W22-01 wires
// it into the scan-runner (CLOSE_THE_LOOP.md, "W22-02 slice 1").

export type Lang = 'ts' | 'py' | 'go' | 'rust' | 'clike';

const EXT: [RegExp, Lang][] = [
  [/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, 'ts'],
  [/\.pyi?$/, 'py'],
  [/\.go$/, 'go'],
  [/\.rs$/, 'rust'],
  [/\.(java|kt|kts|scala|cs|swift|c|h|cc|cpp|cxx|hpp|hh|php|dart)$/, 'clike'],
];

export function langOf(file: string): Lang | null {
  for (const [re, lang] of EXT) if (re.test(file)) return lang;
  return null;
}

/** Languages whose parameters are written `Type name` rather than `name: Type`. */
const TYPE_FIRST = /\.(java|cs|c|h|cc|cpp|cxx|hpp|hh|dart)$/;

export function maskFor(lang: Lang, source: string): string {
  switch (lang) {
    case 'py':
      return maskPython(source);
    case 'go':
      return maskGo(source);
    case 'rust':
      return maskRust(source);
    default:
      return maskSource(source);
  }
}

export interface FileView {
  file: string;
  lang: Lang;
  raw: string[];
  masked: string[];
  maskedText: string;
  /** Offset of the first character of each line in maskedText. */
  starts: number[];
}

export function viewOf(file: string, source: string, lang = langOf(file)): FileView | null {
  if (!lang) return null;
  let maskedText: string;
  try {
    maskedText = maskFor(lang, source);
  } catch {
    return null;
  }
  const raw = source.split('\n');
  const masked = maskedText.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const l of masked) {
    starts.push(at);
    at += l.length + 1;
  }
  return { file, lang, raw, masked, maskedText, starts };
}

function lineOf(view: FileView, offset: number): number {
  let lo = 0;
  let hi = view.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((view.starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const indentOf = (s: string): number => /^[ \t]*/.exec(s)![0].replace(/\t/g, '    ').length;
const blank = (s: string): boolean => s.trim() === '';

// ---------------------------------------------------------------------------
// Enclosing function and class

export interface Scope {
  name: string | null;
  startLine: number;
  endLine: number;
  /** The text from the start of the declaration to its body's opening (masked). */
  header: string;
}

export interface Enclosing {
  /** The innermost function around the hit, named or not. */
  fn: Scope | null;
  /** The nearest NAMED function around the hit (whose callers are worth finding). */
  named: Scope | null;
  /** The class (struct, impl, ...) around the hit. */
  cls: Scope | null;
}

const CONTROL =
  /^(?:else\s+)?(?:if|for|foreach|while|switch|catch|try|finally|do|else|with|synchronized|unsafe|loop|match|select|when|guard|defer|go|lock|using|fixed|checked|unchecked)\b/;
const CLASSY =
  /\b(?:class|struct|interface|trait|impl|object|enum|record|namespace|module|extension|protocol)\b/;
const RESERVED = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'new',
  'typeof',
  'function',
  'func',
  'fn',
  'await',
  'yield',
  'throw',
  'case',
  'sizeof',
  'super',
  'this',
  'self',
]);

function functionName(header: string): { fn: boolean; name: string | null } {
  const h = header.replace(/\s+/g, ' ').trim();
  if (!h || CONTROL.test(h)) return { fn: false, name: null };
  let m: RegExpExecArray | null;
  if ((m = /\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?/.exec(h))) {
    if (m[1]) return { fn: true, name: m[1] };
    // `const x = function (...)`: the variable names it.
    const v = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?function\b/.exec(h);
    return { fn: true, name: v?.[1] ?? null };
  }
  if ((m = /\bfunc\b\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)?\s*[[(]/.exec(h)))
    return { fn: true, name: m[1] ?? null };
  if ((m = /\bfn\s+([A-Za-z_]\w*)/.exec(h))) return { fn: true, name: m[1] as string };
  if ((m = /\bfun\s+(?:[\w.<>]+\.)?([A-Za-z_]\w*)/.exec(h)))
    return { fn: true, name: m[1] as string };
  if (h.includes('=>')) {
    const v =
      /(?:^|[\s,;])([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^]*?\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>\s*$/.exec(
        h,
      );
    return { fn: true, name: v?.[1] ?? null };
  }
  if (CLASSY.test(h) && !h.includes('=')) return { fn: false, name: null };
  // Method syntax: the identifier right before the first top-level '('.
  const paren = h.indexOf('(');
  if (paren > 0 && h.includes(')')) {
    const before = h.slice(0, paren).trimEnd();
    const id = /([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?$/.exec(before);
    if (!id || RESERVED.has(id[1] as string)) return { fn: false, name: null };
    const lead = before.slice(0, before.length - id[0].length).trimEnd();
    // `foo.bar(x) {` (a call with a trailing block) or `x = call(...) {` is not a declaration.
    if (
      lead.endsWith('.') ||
      /=\s*$/.test(lead) ||
      /[=(,]/.test(lead.replace(/@\w+(\([^)]*\))?/g, ''))
    ) {
      return { fn: true, name: null };
    }
    return { fn: true, name: id[1] as string };
  }
  return { fn: false, name: null };
}

function className(header: string): string | null {
  const h = header.replace(/\s+/g, ' ').trim();
  const go = /\btype\s+([A-Za-z_]\w*)\s+struct\b/.exec(h);
  if (go) return go[1] as string;
  const m =
    /\b(?:class|struct|interface|trait|impl(?:\s*<[^>]*>)?|object|enum|record|extension|protocol)\s+([A-Za-z_$][\w$]*)/.exec(
      h,
    );
  return m?.[1] ?? null;
}

function braceEnclosing(view: FileView, hitLine: number): Enclosing {
  const text = view.maskedText;
  const lineText = view.masked[hitLine - 1] ?? '';
  const pos = (view.starts[hitLine - 1] ?? 0) + (lineText.length - lineText.trimStart().length);
  // Every brace pair around `pos`, innermost first.
  const stack: number[] = [];
  const around: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') stack.push(i);
    else if (ch === '}') {
      const open = stack.pop();
      if (open !== undefined && open < pos && i > pos) around.push([open, i]);
    }
  }
  around.sort((a, b) => b[0] - a[0]);
  const out: Enclosing = { fn: null, named: null, cls: null };
  for (const [open, close] of around) {
    let boundary = -1;
    for (let k = open - 1; k >= 0; k--) {
      const ch = text[k];
      if (ch === ';' || ch === '{' || ch === '}') {
        boundary = k;
        break;
      }
    }
    // Languages without `;` (Go, Kotlin, Swift, semicolon-free TS) put the
    // previous statement inside that span: start the header at the line the
    // declaration starts on — up from the brace while its parentheses are
    // unbalanced or the line continues the one above — plus any decorators.
    const minLine = lineOf(view, boundary + 1);
    const from = (l: number): string =>
      text.slice(Math.max(view.starts[l - 1] ?? 0, boundary + 1), open);
    let startLine = lineOf(view, open);
    while (startLine > minLine) {
      const h = from(startLine);
      const unbalanced = (h.match(/\)/g)?.length ?? 0) > (h.match(/\(/g)?.length ?? 0);
      const first = h.trim();
      const prev = (view.masked[startLine - 2] ?? '').trimEnd();
      if (
        unbalanced ||
        first === '' ||
        /^(?:extends|implements|where|throws|:|->|=>|\.|&&|\|\||<)/.test(first) ||
        /(?:[,(=&|:<]|=>|\bextends|\bimplements)$/.test(prev) ||
        /^\s*@/.test(prev)
      ) {
        startLine -= 1;
      } else {
        break;
      }
    }
    const header = from(startLine);
    const firstChar = open - header.length + (header.length - header.trimStart().length);
    const scope = (name: string | null): Scope => ({
      name,
      startLine: lineOf(view, firstChar),
      endLine: lineOf(view, close),
      header,
    });
    const f = functionName(header);
    if (f.fn) {
      out.fn ??= scope(f.name);
      if (f.name && !out.named) out.named = scope(f.name);
      continue;
    }
    const c = className(header);
    const classy =
      CLASSY.test(header.replace(/\s+/g, ' ')) || /\btype\s+\w+\s+struct\b/.test(header);
    if (c && classy) {
      if (!out.cls) out.cls = scope(c);
      // A hit in a class body outside any method (a field initialiser) has no function.
      if (out.named) break;
    }
  }
  return out;
}

function pyBlockEnd(view: FileView, defLine: number): number {
  const indent = indentOf(view.masked[defLine - 1] ?? '');
  let end = defLine;
  for (let i = defLine; i < view.masked.length; i++) {
    const l = view.masked[i] as string;
    if (blank(l)) continue;
    if (indentOf(l) <= indent) break;
    end = i + 1;
  }
  return end;
}

function pyEnclosing(view: FileView, hitLine: number): Enclosing {
  const out: Enclosing = { fn: null, named: null, cls: null };
  let cur = Number.POSITIVE_INFINITY;
  for (let i = hitLine - 1; i >= 0; i--) {
    const l = view.masked[i] as string;
    if (blank(l)) continue;
    const ind = indentOf(l);
    if (i === hitLine - 1) {
      cur = ind;
      continue;
    }
    if (ind >= cur) continue;
    cur = ind;
    const def = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(l);
    const cls = /^\s*class\s+([A-Za-z_]\w*)/.exec(l);
    // Decorators sit above a def and belong to it.
    let start = i + 1;
    while (start > 1 && /^\s*@/.test(view.masked[start - 2] as string)) start -= 1;
    if (def) {
      const s: Scope = {
        name: def[1] as string,
        startLine: start,
        endLine: pyBlockEnd(view, i + 1),
        header: l,
      };
      // Python keeps the header's full parameter list on the `def` line(s) until ':'.
      let j = i;
      let header = l;
      while (!/\)\s*(?:->[^:]*)?:\s*$/.test(header) && j + 1 < view.masked.length && j < i + 20) {
        j += 1;
        header += `\n${view.masked[j]}`;
      }
      s.header = header;
      out.fn ??= s;
      out.named ??= s;
    } else if (cls) {
      out.cls = {
        name: cls[1] as string,
        startLine: start,
        endLine: pyBlockEnd(view, i + 1),
        header: l,
      };
      break;
    }
    if (ind === 0) break;
  }
  return out;
}

export function enclosingAt(view: FileView, hitLine: number): Enclosing {
  return view.lang === 'py' ? pyEnclosing(view, hitLine) : braceEnclosing(view, hitLine);
}

// ---------------------------------------------------------------------------
// Names used on the flagged lines

export interface NameRef {
  /** `workingTable` for `this.workingTable`, `Limit` for `cfg.Limit`. */
  name: string;
  /** `this` / `self` for a member of the current object; a package or module alias. */
  owner: string | null;
  /** As written: `this.workingTable`. */
  label: string;
  /** Followed by '(' on the line. */
  call: boolean;
}

const KEYWORDS = new Set(
  (
    'abstract and as assert async await break case catch class const constructor continue ' +
    'debugger def default defer del delete do elif else enum except export extends false ' +
    'final finally fn for from func function go goto if impl import in instanceof interface ' +
    'is lambda let loop match mod mut new nil none not null of or package pass private ' +
    'protected pub public raise readonly return select self static struct super switch ' +
    'this throw throws true try type typeof undefined use val var void when where while ' +
    'with yield None True False struct chan map range fun val override internal crate ' +
    'int string bool float double long char byte any number boolean unknown never object'
  ).split(' '),
);

const GLOBALS = new Set(
  (
    'console window document process JSON Math Object Array Promise String Number Boolean ' +
    'Date Error Map Set Symbol RegExp Buffer require module exports globalThis setTimeout ' +
    'len print str int dict list tuple range isinstance super fmt errors log os sys'
  ).split(' '),
);

/** Text of the lines with Python f-string expressions recovered (masking blanks them). */
function pyFStringExprs(raw: string): string {
  const out: string[] = [];
  for (const m of raw.matchAll(/\b[fF][rR]?(['"])(.*?)\1|\b[rR][fF](['"])(.*?)\3/g)) {
    const body = (m[2] ?? m[4] ?? '') as string;
    for (const e of body.matchAll(/\{([^{}]+)\}/g))
      out.push((e[1] as string).split(/[!:]/)[0] as string);
  }
  return out.join(' ; ');
}

/**
 * Names the flagged lines use, in order of appearance. A `x.y` member is kept
 * only when `x` is `this`/`self` or one of `owners` (import aliases); any other
 * member is a property of some value, not a name with a declaration.
 */
export function namesOnLines(
  view: FileView,
  lineStart: number,
  lineEnd: number,
  owners: ReadonlySet<string> = new Set(),
  max = 16,
): NameRef[] {
  const parts: string[] = [];
  for (let l = lineStart; l <= lineEnd && l <= view.masked.length; l++) {
    parts.push(view.masked[l - 1] as string);
    if (view.lang === 'py') parts.push(pyFStringExprs(view.raw[l - 1] ?? ''));
  }
  const text = parts.join('\n');
  const seen = new Set<string>();
  const out: NameRef[] = [];
  const ident = /[A-Za-z_$][\w$]*/g;
  for (const m of text.matchAll(ident)) {
    const name = m[0];
    const at = m.index ?? 0;
    if (/[\w$]/.test(text[at - 1] ?? '')) continue;
    if (/^\d/.test(name)) continue;
    const after = text.slice(at + name.length);
    const call = /^\s*\(/.test(after);
    let k = at - 1;
    while (k >= 0 && /[ \t]/.test(text[k] as string)) k--;
    let owner: string | null = null;
    if (text[k] === '.' && text[k - 1] !== '.') {
      let j = k - 1;
      while (j >= 0 && /[ \t]/.test(text[j] as string)) j--;
      const prev = /[A-Za-z_$][\w$]*$/.exec(text.slice(Math.max(0, j - 80), j + 1));
      if (!prev) continue;
      // A member of something other than the current object or a package is a property, not a name.
      owner = prev[0];
      if (owner !== 'this' && owner !== 'self' && !owners.has(owner)) continue;
    } else if (/^\s*\.(?!\.)/.test(after) && (name === 'this' || name === 'self')) {
      continue;
    }
    if (KEYWORDS.has(name) && owner === null) continue;
    if (owner === null && GLOBALS.has(name)) continue;
    const label = owner ? `${owner}.${name}` : name;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ name, owner, label, call });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declarations in one file

export interface Declaration {
  kind: DefinitionKind;
  line: number;
  text: string;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The declaration's own line, plus continuation lines while brackets stay open (at most 4 lines). */
function declText(view: FileView, line: number): string {
  const lines = [view.raw[line - 1] ?? ''];
  let depth = 0;
  const count = (s: string): void => {
    for (const ch of s) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
  };
  count(view.masked[line - 1] ?? '');
  let l = line;
  const opensValue = /[=,(]\s*$/.test(view.masked[line - 1] ?? '');
  while ((depth > 0 || (opensValue && l === line)) && l < view.raw.length && lines.length < 4) {
    l += 1;
    lines.push(view.raw[l - 1] ?? '');
    count(view.masked[l - 1] ?? '');
  }
  return lines.map((s) => (s.length > 300 ? `${s.slice(0, 300)}…` : s)).join('\n');
}

type Pattern = { re: RegExp; kind: DefinitionKind | ((line: string) => DefinitionKind) };

function plainPatterns(lang: Lang, n: string): Pattern[] {
  const N = esc(n);
  const constOrVar = (line: string): DefinitionKind =>
    /\b(const|final|static|constexpr|define|val)\b/.test(line) ? 'module_const' : 'variable';
  switch (lang) {
    case 'ts':
      return [
        {
          re: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${N}\\b`),
          kind: (l) =>
            /^(?:export\s+)?(?:declare\s+)?const\b/.test(l) ? 'module_const' : 'variable',
        },
        {
          re: new RegExp(
            `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+[^=]*?[{,]\\s*${N}\\s*[,}]`,
          ),
          kind: 'variable',
        },
        {
          re: new RegExp(
            `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${N}\\b`,
          ),
          kind: 'function',
        },
        {
          re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${N}\\b`),
          kind: 'class',
        },
        {
          re: new RegExp(
            `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?(?:enum|type|interface)\\s+${N}\\b`,
          ),
          kind: 'type',
        },
      ];
    case 'py':
      return [
        { re: new RegExp(`^${N}\\s*(?::[^=]+)?=(?!=)`), kind: 'module_const' },
        { re: new RegExp(`^\\s+${N}\\s*(?::[^=]+)?=(?!=)`), kind: 'variable' },
        { re: new RegExp(`^\\s*(?:async\\s+)?def\\s+${N}\\s*\\(`), kind: 'function' },
        { re: new RegExp(`^\\s*class\\s+${N}\\b`), kind: 'class' },
      ];
    case 'go':
      return [
        { re: new RegExp(`^const\\s+${N}\\b`), kind: 'module_const' },
        { re: new RegExp(`^var\\s+${N}\\b`), kind: 'variable' },
        { re: new RegExp(`^\\s+(?:const|var)\\s+${N}\\b`), kind: 'variable' },
        { re: new RegExp(`(?:^|[\\s,(])${N}\\s*(?:,\\s*[A-Za-z_]\\w*\\s*)*:=`), kind: 'variable' },
        { re: new RegExp(`^\\s*[A-Za-z_]\\w*\\s*,\\s*${N}\\s*:=`), kind: 'variable' },
        { re: new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${N}\\s*[[(]`), kind: 'function' },
        { re: new RegExp(`^type\\s+${N}\\b`), kind: 'type' },
      ];
    case 'rust':
      return [
        {
          re: new RegExp(
            `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const|static)\\s+(?:mut\\s+)?${N}\\b`,
          ),
          kind: 'module_const',
        },
        { re: new RegExp(`\\blet\\s+(?:mut\\s+)?${N}\\b`), kind: 'variable' },
        { re: new RegExp(`\\bfn\\s+${N}\\b`), kind: 'function' },
        { re: new RegExp(`\\b(?:struct|enum|type|trait)\\s+${N}\\b`), kind: 'type' },
      ];
    default:
      return [
        { re: new RegExp(`^\\s*#\\s*define\\s+${N}\\b`), kind: 'module_const' },
        {
          re: new RegExp(
            `\\b(?:const|final|static|val|var|let|readonly|constexpr|define)\\b[^=;(\\n]*?\\b${N}\\s*(?::[^=]+)?=(?!=)`,
          ),
          kind: constOrVar,
        },
        {
          re: new RegExp(`\\b(?:class|struct|enum|interface|record|object)\\s+${N}\\b`),
          kind: 'class',
        },
      ];
  }
}

function memberPatterns(lang: Lang, n: string): Pattern[] {
  const N = esc(n);
  switch (lang) {
    case 'ts':
      return [
        {
          re: new RegExp(
            `^\\s*(?:(?:public|private|protected|readonly|static|declare|override|abstract|accessor)\\s+)*#?${N}\\s*[?!]?\\s*(?::[^=;(]*)?(?:=(?![=>])|;|$)`,
          ),
          kind: 'class_field',
        },
        {
          re: new RegExp(`\\b(?:public|private|protected|readonly)\\s+${N}\\s*[?:,)=]`),
          kind: 'class_field',
        },
        { re: new RegExp(`\\bthis\\s*\\.\\s*#?${N}\\s*=(?![=>])`), kind: 'class_field' },
        {
          re: new RegExp(`^\\s*(?:(?:public|private|protected|static)\\s+)*get\\s+${N}\\s*\\(`),
          kind: 'function',
        },
        {
          re: new RegExp(
            `^\\s*(?:(?:public|private|protected|static|async|override)\\s+)*${N}\\s*(?:<[^>]*>)?\\s*\\(.*\\)\\s*(?::[^{]*)?\\{\\s*$`,
          ),
          kind: 'function',
        },
      ];
    case 'py':
      return [
        { re: new RegExp(`\\bself\\s*\\.\\s*${N}\\s*(?::[^=]+)?=(?!=)`), kind: 'class_field' },
        { re: new RegExp(`^\\s+${N}\\s*(?::[^=]+)?=(?!=)`), kind: 'class_field' },
        { re: new RegExp(`^\\s*(?:async\\s+)?def\\s+${N}\\s*\\(`), kind: 'function' },
      ];
    case 'rust':
      return [
        { re: new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?${N}\\s*:`), kind: 'class_field' },
        { re: new RegExp(`\\bfn\\s+${N}\\b`), kind: 'function' },
      ];
    default:
      return [
        { re: new RegExp(`\\bthis\\s*\\.\\s*${N}\\s*=(?!=)`), kind: 'class_field' },
        {
          re: new RegExp(
            `^\\s*(?:(?:public|private|protected|internal|static|final|readonly|const|lateinit|open|override)\\s+)*(?:val|var|let|[\\w<>\\[\\],.?]+)\\s+${N}\\s*(?::[^=;]+)?(?:=(?!=)|;|$)`,
          ),
          kind: 'class_field',
        },
      ];
  }
}

/**
 * Where `ref` is declared in this file, at most `max` places, earliest first.
 * A member of `this`/`self` is looked for inside `cls` only (when known); a
 * plain name anywhere in the file, excluding `skip` (lines already shown).
 */
export function declarationsOf(
  view: FileView,
  ref: Pick<NameRef, 'name' | 'owner'>,
  opts: { cls?: Scope | null; skip?: (line: number) => boolean; max?: number } = {},
): Declaration[] {
  const member = ref.owner === 'this' || ref.owner === 'self';
  const patterns = member
    ? memberPatterns(view.lang, ref.name)
    : plainPatterns(view.lang, ref.name);
  const [from, to] =
    member && opts.cls ? [opts.cls.startLine, opts.cls.endLine] : [1, view.masked.length];
  const out: Declaration[] = [];
  const max = opts.max ?? 2;
  // Go groups `const ( ... )` / `var ( ... )`: a name on its own line inside one is declared there.
  let goGroup: 'const' | 'var' | null = null;
  for (let line = from; line <= to && out.length < max; line++) {
    const text = view.masked[line - 1] ?? '';
    if (view.lang === 'go' && !member) {
      const open = /^(const|var)\s*\(\s*$/.exec(text);
      if (open) {
        goGroup = open[1] as 'const' | 'var';
        continue;
      }
      if (goGroup && /^\)/.test(text)) goGroup = null;
      else if (
        goGroup &&
        new RegExp(`^\\s+(?:[A-Za-z_]\\w*\\s*,\\s*)*${esc(ref.name)}\\b(?!\\s*\\()`).test(text)
      ) {
        if (!opts.skip?.(line))
          out.push({
            kind: goGroup === 'const' ? 'module_const' : 'variable',
            line,
            text: declText(view, line),
          });
        continue;
      }
    }
    if (opts.skip?.(line)) continue;
    for (const p of patterns) {
      if (!p.re.test(text)) continue;
      // A member pattern that reads like a plain declaration must sit directly in the class body.
      if (
        member &&
        view.lang === 'py' &&
        p.kind === 'class_field' &&
        !text.includes('self') &&
        opts.cls
      ) {
        const bodyIndent = classBodyIndent(view, opts.cls);
        if (indentOf(text) !== bodyIndent) continue;
      }
      if (member && view.lang === 'ts' && p.re.source.startsWith('^') && opts.cls) {
        if (indentOf(text) !== classBodyIndent(view, opts.cls)) continue;
      }
      const kind = typeof p.kind === 'function' ? p.kind(text) : p.kind;
      out.push({ kind, line, text: declText(view, line) });
      break;
    }
  }
  return out;
}

function classBodyIndent(view: FileView, cls: Scope): number {
  for (let l = cls.startLine + 1; l <= cls.endLine; l++) {
    const t = view.masked[l - 1] ?? '';
    if (!blank(t) && !/^\s*[})]/.test(t)) return indentOf(t);
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Parameters of a function header

export function parametersOf(view: FileView, fn: Scope): Map<string, number> {
  const out = new Map<string, number>();
  const header = fn.header;
  // Go methods start with a receiver list; the parameters follow the name.
  let open = header.indexOf('(');
  if (view.lang === 'go' && fn.name) {
    const at = new RegExp(`\\b${esc(fn.name)}\\s*(?:\\[[^\\]]*\\])?\\s*\\(`).exec(header);
    if (at) open = at.index + at[0].length - 1;
  }
  if (open < 0) {
    // A bare-arrow parameter: `x => {`.
    const bare = /([A-Za-z_$][\w$]*)\s*=>\s*$/.exec(header.trim());
    if (bare) out.set(bare[1] as string, fn.startLine);
    return out;
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < header.length; i++) {
    const ch = header[i];
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') {
      if (header[i - 1] === '=' && ch === '>') continue;
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return out;
  const inner = header.slice(open + 1, close);
  const headerStartOffset = header.length - header.trimStart().length;
  const parts: { text: string; at: number }[] = [];
  depth = 0;
  let from = 0;
  for (let i = 0; i <= inner.length; i++) {
    const ch = inner[i];
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--;
    if ((ch === ',' && depth === 0) || i === inner.length) {
      parts.push({ text: inner.slice(from, i), at: from });
      from = i + 1;
    }
  }
  const typeFirst = TYPE_FIRST.test(view.file);
  for (const p of parts) {
    const decl = p.text
      .split('=')[0]!
      .replace(
        /^\s*(?:(?:public|private|protected|readonly|override|final|mut|ref|out|in|params)\s+)*/,
        '',
      )
      .replace(/^\s*(?:\.\.\.|\*\*|\*|&)/, '');
    if (/^\s*[{[]/.test(decl)) continue;
    const ids = [...decl.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
    const name = typeFirst ? ids.at(-1) : ids[0];
    if (!name || name === 'self' || name === 'cls' || name === 'this') continue;
    const lineInHeader = header.slice(headerStartOffset, open + 1 + p.at).split('\n').length - 1;
    out.set(name, fn.startLine + lineInHeader);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Imports

export interface ImportedName {
  local: string;
  /** The name in the module it comes from; 'default' / '*' where that applies. */
  imported: string;
  specifier: string;
  line: number;
}

export function importsIn(view: FileView): ImportedName[] {
  const out: ImportedName[] = [];
  const raw = view.raw.join('\n');
  if (view.lang === 'ts') {
    const re = /\bimport\s+(?:type\s+)?([^'"`;]*?)\s*from\s*(['"])([^'"]*)\2/dg;
    for (const m of view.maskedText.matchAll(re)) {
      const [s, e] = m.indices?.[3] ?? [0, 0];
      const specifier = raw.slice(s, e);
      const line = lineOf(view, m.index ?? 0);
      const clause = (m[1] as string).trim();
      const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (ns) out.push({ local: ns[1] as string, imported: '*', specifier, line });
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces) {
        for (const part of (braces[1] as string).split(',')) {
          const p = part.replace(/^\s*type\s+/, '').trim();
          if (!p) continue;
          const [orig, alias] = p.split(/\s+as\s+/).map((x) => x.trim());
          out.push({ local: alias ?? (orig as string), imported: orig as string, specifier, line });
        }
      }
      const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
      if (def && !clause.startsWith('{'))
        out.push({ local: def[1] as string, imported: 'default', specifier, line });
    }
  } else if (view.lang === 'py') {
    for (let i = 0; i < view.masked.length; i++) {
      const plain = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(view.raw[i] as string);
      if (plain && !blank(view.masked[i] as string)) {
        const mod = plain[1] as string;
        out.push({
          local: plain[2] ?? (mod.split('.')[0] as string),
          imported: '*',
          specifier: plain[2] ? mod : (mod.split('.')[0] as string),
          line: i + 1,
        });
        continue;
      }
      const m = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.*)$/.exec(view.raw[i] as string);
      if (!m || blank(view.masked[i] as string)) continue;
      let names = m[2] as string;
      if (names.includes('(') && !names.includes(')')) {
        for (let j = i + 1; j < view.raw.length && j < i + 40; j++) {
          names += ` ${view.raw[j]}`;
          if ((view.raw[j] as string).includes(')')) break;
        }
      }
      for (const part of names.replace(/[()]/g, '').replace(/#.*$/gm, '').split(',')) {
        const [orig, alias] = part
          .trim()
          .split(/\s+as\s+/)
          .map((x) => x.trim());
        if (!orig || orig === '*') continue;
        out.push({ local: alias ?? orig, imported: orig, specifier: m[1] as string, line: i + 1 });
      }
    }
  }
  return out;
}

/** Python module specifier → candidate snapshot paths, nearest first. */
export function pythonModuleCandidates(fromFile: string, specifier: string): string[] {
  const dots = /^\.*/.exec(specifier)![0].length;
  const mod = specifier.slice(dots).split('.').filter(Boolean).join('/');
  if (dots > 0) {
    const dir = fromFile.split('/').slice(0, -1);
    const base = dir.slice(0, Math.max(0, dir.length - (dots - 1)));
    const stem = [...base, ...(mod ? [mod] : [])].join('/');
    return [`${stem}.py`, `${stem}/__init__.py`];
  }
  return [`${mod}.py`, `${mod}/__init__.py`, `src/${mod}.py`, `src/${mod}/__init__.py`];
}
