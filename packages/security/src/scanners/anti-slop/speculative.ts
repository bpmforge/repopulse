import { CODE, IDENT, exportsOf, lineAt, maskSource } from './source-graph.js';
import {
  closing,
  isGenerated,
  NON_PRODUCT_PATH,
  skipSpace,
  splitTopLevel,
  statementEnd,
} from './code-shape.js';

// Speculative generality (W18-08, mechanical-checks plan §E: R-17 speculative
// generalisation, R-12 orphan feature flag).
//
// Both are knobs nobody turns. A model asked for a function writes the
// options it imagines a caller might want; asked for a feature, it puts it
// behind `ENABLE_X = true` and never mentions it again. Each knob is a branch
// someone has to read, test and keep working for a caller that does not exist.
//
// Both rules can only claim what the repository shows, so each one is limited
// to where the repository shows EVERYTHING: a parameter of a function nothing
// outside its file can reach, and a flag whose every read is in the snapshot.

export const SPECULATIVE_PARAM_RULE_ID = 'slop.speculative_param';
export const ORPHAN_FLAG_RULE_ID = 'slop.orphan_flag';

export interface SpeculativeFinding {
  ruleId: typeof SPECULATIVE_PARAM_RULE_ID | typeof ORPHAN_FLAG_RULE_ID;
  file: string;
  line: number;
  /** The declaring line, verbatim — the evidence quote. */
  evidence: string;
  /** The parameter or the flag. */
  name: string;
  message: string;
}

// ---------------------------------------------------------------------------
// slop.speculative_param

interface FunctionDecl {
  name: string;
  /** Offset of the name in the declaration. */
  nameIndex: number;
  paramsOpen: number;
  paramsClose: number;
}

const DECLARATIONS = [
  // function name(…) · async function name<T>(…) · function* name(…)
  new RegExp(`\\bfunction\\s*\\*?\\s*(${IDENT})\\s*(?:<[^>(]*>)?\\s*\\(`, 'dg'),
  // const name = (…) => · const name = async function (…) · const name: T = (…) =>
  new RegExp(
    `\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?` +
      `(?:function\\b\\s*\\*?\\s*(?:${IDENT})?\\s*)?(?:<[^>(]*>)?\\s*\\(`,
    'dg',
  ),
];

function functionDecls(masked: string): FunctionDecl[] {
  const out: FunctionDecl[] = [];
  for (const re of DECLARATIONS) {
    for (const m of masked.matchAll(re)) {
      const name = m[1] as string;
      const paramsOpen = m.index + m[0].length - 1;
      const paramsClose = closing(masked, paramsOpen);
      if (paramsClose < 0) continue;
      const after = masked.slice(paramsClose + 1, paramsClose + 400);
      const isFunctionKeyword = /\bfunction\b/.test(m[0]);
      // Without `function`, the parenthesis is an arrow's only if `=>` follows
      // (past a return annotation). `const x = (a = 1)` is not a declaration.
      if (!isFunctionKeyword && !/^\s*(?::[^;{}]*?)?=>/.test(after)) continue;
      // An overload signature or `declare function` has no body to default.
      if (isFunctionKeyword && !/^\s*(?::[^;{}]*?)?\{/.test(after)) continue;
      out.push({ name, nameIndex: m.indices?.[1]?.[0] ?? m.index, paramsOpen, paramsClose });
    }
  }
  return out;
}

interface Param {
  index: number;
  name: string;
  /** The default's text, e.g. `{}` or `5`. */
  fallback: string;
}

/** `=` at the top level of a parameter: not `=>`, `==`, `<=`, `>=`, `!=`. */
function defaultSplit(param: string): number {
  let depth = 0;
  for (let i = 0; i < param.length; i++) {
    const c = param[i] as string;
    if ('([{<'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === '>' && param[i - 1] !== '=') depth--;
    else if (
      c === '=' &&
      depth === 0 &&
      param[i + 1] !== '>' &&
      param[i + 1] !== '=' &&
      !'=<>!'.includes(param[i - 1] ?? '')
    ) {
      return i;
    }
  }
  return -1;
}

function defaultedParams(paramText: string): Param[] {
  let parts = splitTopLevel(paramText, true);
  // TypeScript's `this` parameter is not passed positionally.
  if (parts[0] && /^this\s*:/.test(parts[0])) parts = parts.slice(1);
  const out: Param[] = [];
  for (const [index, part] of parts.entries()) {
    const at = defaultSplit(part);
    if (at < 0) continue;
    const head = part.slice(0, at).trim();
    const name = /^[{[]/.test(head)
      ? 'options object'
      : (head.replace(/\?$/, '').split(':')[0] ?? '').trim();
    out.push({ index, name, fallback: part.slice(at + 1).trim() });
  }
  return out;
}

/** The function's body text (masked): a block, or an arrow's expression. */
function bodyOf(masked: string, paramsClose: number): string {
  const arrow = /^\s*(?::[^;{}]*?)?=>\s*/.exec(masked.slice(paramsClose + 1));
  const from = arrow ? paramsClose + 1 + arrow[0].length : masked.indexOf('{', paramsClose);
  if (from < 0) return '';
  if (masked[from] === '{') {
    const close = closing(masked, from);
    return close < 0 ? '' : masked.slice(from, close + 1);
  }
  return masked.slice(from, statementEnd(masked, from));
}

function reassigned(body: string, name: string): boolean {
  const n = name.replace(/\$/g, '\\$');
  return new RegExp(
    `(?<![\\w$.])${n}\\s*(?:[-+*/%&|^]?=(?!=)|\\+\\+|--|\\.(?:push|pop|shift|unshift|splice|set|add|delete|clear)\\s*\\(|\\[[^\\]]*\\]\\s*=(?!=))|(?:\\+\\+|--)${n}\\b`,
  ).test(body);
}

interface CallSite {
  args: string[];
}

/**
 * Defaults that are a fixed choice: a literal, an empty object or array, or a
 * named constant. A default computed from other parameters or from the
 * environment (`x = xs[0]`, `end = str.length`, `argv = process.argv`) is a
 * local variable declared in the parameter list, or an injection seam — a
 * different idiom, and not a knob anyone forgot to turn.
 */
const KNOB_DEFAULT =
  /^(?:[-+]?(?:\d[\d_]*\.?\d*(?:e[-+]?\d+)?|0x[\da-fA-F_]+|Infinity)n?|true|false|null|(['"`])\s*\1|\{\s*\}|\[\s*\]|[A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)?)(?:\s+as\s+[\w$.<>[\]|' ]+)?$/;

/** Arguments that leave a default in force. */
const NOT_PASSED = /^(?:undefined|void\s+0)$/;

function speculativeParams(file: string, source: string): SpeculativeFinding[] {
  const masked = maskSource(source);
  const withStrings = maskSource(source, true);
  const lines = source.split('\n');
  const exported = new Set(exportsOf(source, masked).map((e) => e.name));
  const decls = functionDecls(masked);
  const declaredTwice = new Set(
    decls.map((d) => d.name).filter((n, i, all) => all.indexOf(n) !== i),
  );
  const found: SpeculativeFinding[] = [];

  for (const decl of decls) {
    if (declaredTwice.has(decl.name) || exported.has(decl.name)) continue;
    const before = masked.slice(Math.max(0, decl.nameIndex - 80), decl.nameIndex);
    // `export default function name`, `export const name` — someone else's call.
    if (
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var)\s*$/.test(before)
    ) {
      continue;
    }
    const params = defaultedParams(masked.slice(decl.paramsOpen + 1, decl.paramsClose));
    if (params.length === 0) continue;
    const body = bodyOf(masked, decl.paramsClose);
    // `arguments` reads what was passed without naming it.
    if (/\barguments\b/.test(body)) continue;

    // Every other mention of the name must be a direct call we can count.
    // Anything else — passed as a callback (where `map` passes an index into
    // the defaulted slot), exported in an object, named in a string that
    // might be a lookup, used in JSX — means callers the text cannot count.
    const calls: CallSite[] = [];
    let countable = true;
    // Not after a single `.`: `other.name(` is another object's method. After
    // `...` it is still our function, spread into something.
    const re = new RegExp(`(?<![\\w$#]|[^.]\\.)${decl.name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
    for (const m of withStrings.matchAll(re)) {
      if (m.index === decl.nameIndex) continue;
      if (masked.slice(m.index, m.index + decl.name.length) !== decl.name) {
        countable = false; // inside a string or template text
        break;
      }
      let open = skipSpace(masked, m.index + decl.name.length);
      if (masked[open] === '<') {
        const generic = /^<[^()=;]*>\s*/.exec(masked.slice(open));
        if (generic) open += generic[0].length;
      }
      if (masked[open] !== '(' || /\b(?:typeof|new)\s*$/.test(masked.slice(0, m.index))) {
        countable = false;
        break;
      }
      const close = closing(masked, open);
      if (close < 0) {
        countable = false;
        break;
      }
      const args = splitTopLevel(masked.slice(open + 1, close));
      if (args.some((a) => a.startsWith('...'))) {
        countable = false;
        break;
      }
      calls.push({ args });
    }
    if (!countable || calls.length === 0) continue;

    for (const param of params) {
      if (!KNOB_DEFAULT.test(param.fallback)) continue;
      // A parameter the body reassigns or fills (`body = []` then
      // `body.push(chunk)`) is a local variable declared in the parameter
      // list, not an option.
      if (param.name !== 'options object' && reassigned(body, param.name)) continue;
      const overridden = calls.some((c) => {
        const arg = c.args[param.index];
        return arg !== undefined && !NOT_PASSED.test(arg);
      });
      if (overridden) continue;
      const line = lineAt(masked, decl.paramsOpen);
      found.push({
        ruleId: SPECULATIVE_PARAM_RULE_ID,
        file,
        line,
        evidence: (lines[line - 1] ?? '').trim(),
        name: `${decl.name}(${param.name})`,
        message:
          `${decl.name} defaults ${param.name} to ${param.fallback.slice(0, 40)}, and none of its ` +
          `${calls.length} call${calls.length === 1 ? '' : 's'} passes anything else. The parameter is ` +
          'a choice nobody makes: inline the default and drop it until a caller needs it.',
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// slop.orphan_flag

/** Names that read as a switch, not as a value. */
const FLAG_NAME =
  /^(?:(?:ENABLE|ENABLED|DISABLE|DISABLED|USE|FEATURE|FF|FLAG|SHOW|HIDE|EXPERIMENTAL|ALLOW|IS)_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(?:ENABLED|DISABLED|FLAG|FEATURE|ON|OFF))$/;

const FLAG_DECL = new RegExp(
  `\\bconst\\s+(${IDENT})\\s*(?::\\s*boolean\\s*)?=\\s*(true|false|!0|!1)\\s*(?:as\\s+const\\s*)?(?=[;\\n,}]|$)`,
  'g',
);

interface FlagDecl {
  file: string;
  name: string;
  value: boolean;
  index: number;
  line: number;
  evidence: string;
}

function orphanFlags(files: readonly { path: string; source: string }[]): SpeculativeFinding[] {
  const decls: FlagDecl[] = [];
  // Mentions are counted with strings KEPT: a flag named in a string may be
  // looked up by that string (a config map, an env override), which is a read
  // the rule cannot follow, so it counts and keeps the flag off the list.
  const texts = files.map((f) => ({ path: f.path, text: maskSource(f.source, true) }));
  for (const f of files) {
    if (NON_PRODUCT_PATH.test(f.path) || isGenerated(f.source)) continue;
    const masked = maskSource(f.source);
    const lines = f.source.split('\n');
    for (const m of masked.matchAll(FLAG_DECL)) {
      const name = m[1] as string;
      // `X_DEFAULT_ENABLED` is the fallback for real configuration (an env var
      // read beside it), which is the opposite of an orphan.
      if (!FLAG_NAME.test(name) || name.includes('DEFAULT')) continue;
      const line = lineAt(masked, m.index);
      decls.push({
        file: f.path,
        name,
        value: m[2] === 'true' || m[2] === '!0',
        index: m.index + m[0].indexOf(name),
        line,
        evidence: (lines[line - 1] ?? '').trim(),
      });
    }
  }
  if (decls.length === 0) return [];

  const declaredTwice = new Set(
    decls.map((d) => d.name).filter((n, i, all) => all.indexOf(n) !== i),
  );
  const found: SpeculativeFinding[] = [];
  for (const decl of decls) {
    if (declaredTwice.has(decl.name)) continue;
    const re = new RegExp(`(?<![\\w$])${decl.name}(?![\\w$])`, 'g');
    let reads = 0;
    for (const t of texts) {
      for (const m of t.text.matchAll(re)) {
        if (t.path === decl.file && m.index === decl.index) continue;
        reads++;
      }
    }
    // Zero reads is an unused variable, which every linter already reports.
    // Two or more is a flag that gates several places — a real switch, even
    // if nobody flips it today.
    if (reads !== 1) continue;
    found.push({
      ruleId: ORPHAN_FLAG_RULE_ID,
      file: decl.file,
      line: decl.line,
      evidence: decl.evidence,
      name: decl.name,
      message:
        `${decl.name} is hard-coded to ${decl.value} and read in exactly one place. It is not a ` +
        `switch anyone can flip — ${decl.value ? 'the off path' : 'the gated code'} is dead. ` +
        'Delete the flag and the branch it no longer chooses, or wire it to real configuration.',
    });
  }
  return found;
}

/** Both rules over a snapshot. */
export function speculativeGenerality(
  files: readonly { path: string; source: string }[],
): SpeculativeFinding[] {
  const code = files.filter((f) => CODE.test(f.path));
  const out: SpeculativeFinding[] = [];
  for (const f of code) {
    if (NON_PRODUCT_PATH.test(f.path) || isGenerated(f.source)) continue;
    out.push(...speculativeParams(f.path, f.source));
  }
  out.push(...orphanFlags(code));
  return out;
}
