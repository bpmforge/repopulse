import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SecretRule } from './rulepack.js';
import { RulepackError } from './rulepack.js';
import { shannonEntropy } from './entropy.js';

// gitleaks' own secrets rules (W22-07), imported verbatim through the
// third-party ledger and run as SHADOW candidates beside ours.
//
// The file is gitleaks' TOML for gitleaks' Go engine. Two things have to be
// done before JavaScript can run it, and both are done here, in code we can
// read, rather than by editing the vendored file:
//
//   1. Parse the TOML. A strict subset, like the YAML loader beside this one:
//      any line it cannot account for throws, because a detector that
//      silently vanishes looks exactly like a clean repository.
//   2. Translate Go RE2 syntax JavaScript lacks: inline flags in the middle of
//      a pattern ((?i) after a literal prefix, (?-i:...), (?i:...), (?s:...)),
//      (?P<name>...), \z, POSIX classes, and a `]` first in a class.
//
// And gitleaks' match semantics, so a rule means here what it means there: the
// secret is the first non-empty capture group (or secretGroup), the entropy
// floor is "at most is too low", generic rules need a digit, and allowlists
// test the secret, the whole match or the line as each one says.

export interface GitleaksAllowlist {
  description?: string;
  regexes: string[];
  regexTarget?: 'secret' | 'match' | 'line';
  stopwords: string[];
  paths: string[];
  condition?: 'OR' | 'AND';
}

export interface GitleaksRule {
  id: string;
  description: string;
  regex?: string;
  keywords: string[];
  entropy?: number;
  path?: string;
  secretGroup?: number;
  allowlists: GitleaksAllowlist[];
}

export interface GitleaksConfig {
  global: GitleaksAllowlist;
  rules: GitleaksRule[];
}

// --- TOML subset -----------------------------------------------------------

type TomlValue = string | number | string[];

/** Reads one string token at `i`: '''literal''' or "basic". */
function readString(text: string, i: number, line: number): { value: string; end: number } {
  if (text.startsWith("'''", i)) {
    const close = text.indexOf("'''", i + 3);
    if (close < 0) throw new RulepackError('unterminated literal string', line);
    return { value: text.slice(i + 3, close), end: close + 3 };
  }
  if (text[i] === "'") {
    const close = text.indexOf("'", i + 1);
    if (close < 0) throw new RulepackError('unterminated literal string', line);
    return { value: text.slice(i + 1, close), end: close + 1 };
  }
  if (text[i] === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    if (j >= text.length) throw new RulepackError('unterminated string', line);
    // TOML basic-string escapes are a subset of JSON's for everything this
    // file uses; JSON.parse throws on anything it does not understand.
    return { value: JSON.parse(text.slice(i, j + 1)) as string, end: j + 1 };
  }
  throw new RulepackError(`expected a string at "${text.slice(i, i + 20)}"`, line);
}

function parseValue(raw: string, line: number): TomlValue {
  const v = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[')) {
    const items: string[] = [];
    let i = 1;
    for (;;) {
      while (i < v.length && /[\s,]/.test(v[i]!)) i++;
      if (v[i] === '#') {
        const nl = v.indexOf('\n', i);
        i = nl < 0 ? v.length : nl;
        continue;
      }
      if (v[i] === ']') {
        if (v.slice(i + 1).trim() !== '') throw new RulepackError('text after array', line);
        return items;
      }
      if (i >= v.length) throw new RulepackError('unterminated array', line);
      const s = readString(v, i, line);
      items.push(s.value);
      i = s.end;
    }
  }
  const s = readString(v, 0, line);
  if (v.slice(s.end).trim() !== '')
    throw new RulepackError(`text after value: ${v.slice(s.end)}`, line);
  return s.value;
}

const RULE_KEYS = new Set([
  'id',
  'description',
  'regex',
  'keywords',
  'entropy',
  'path',
  'secretGroup',
]);
const ALLOW_KEYS = new Set([
  'description',
  'regexes',
  'regexTarget',
  'stopwords',
  'paths',
  'condition',
]);
const TOP_KEYS = new Set(['title', 'minVersion']);

function emptyAllowlist(): GitleaksAllowlist {
  return { regexes: [], stopwords: [], paths: [] };
}

function strList(v: TomlValue, key: string, line: number): string[] {
  if (!Array.isArray(v)) throw new RulepackError(`"${key}" must be an array`, line);
  return v;
}

function setAllowKey(a: GitleaksAllowlist, key: string, v: TomlValue, line: number): void {
  if (!ALLOW_KEYS.has(key)) throw new RulepackError(`unknown allowlist field "${key}"`, line);
  if (key === 'regexes' || key === 'stopwords' || key === 'paths') a[key] = strList(v, key, line);
  else if (key === 'regexTarget') {
    if (v !== 'secret' && v !== 'match' && v !== 'line') {
      throw new RulepackError(`regexTarget "${String(v)}"`, line);
    }
    a.regexTarget = v;
  } else if (key === 'condition') {
    if (v !== 'OR' && v !== 'AND') throw new RulepackError(`condition "${String(v)}"`, line);
    a.condition = v;
  } else a.description = String(v);
}

/** Parses the subset of TOML that gitleaks' generated config uses. */
export function parseGitleaksToml(text: string): GitleaksConfig {
  const lines = text.split('\n');
  const config: GitleaksConfig = { global: emptyAllowlist(), rules: [] };
  let section: 'top' | 'global' | 'rule' | 'ruleAllow' = 'top';
  let rule: GitleaksRule | undefined;
  let allow: GitleaksAllowlist | undefined;

  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    const line = lines[n]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '[allowlist]') {
      section = 'global';
      continue;
    }
    if (line === '[[rules]]') {
      rule = { id: '', description: '', keywords: [], allowlists: [] };
      config.rules.push(rule);
      section = 'rule';
      continue;
    }
    if (line === '[[rules.allowlists]]') {
      if (!rule) throw new RulepackError('allowlist before any rule', lineNo);
      allow = emptyAllowlist();
      rule.allowlists.push(allow);
      section = 'ruleAllow';
      continue;
    }
    const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new RulepackError(`cannot read "${line.slice(0, 40)}"`, lineNo);
    const key = kv[1]!;
    let raw = kv[2]!;
    // A multi-line array runs to the line that closes it.
    if (raw.startsWith('[') && !/\]\s*$/.test(raw)) {
      while (++n < lines.length && lines[n]!.trim() !== ']') raw += '\n' + lines[n];
      if (n >= lines.length) throw new RulepackError('unterminated array', lineNo);
      raw += '\n]';
    }
    const value = parseValue(raw, lineNo);

    if (section === 'top') {
      if (!TOP_KEYS.has(key)) throw new RulepackError(`unknown top-level field "${key}"`, lineNo);
    } else if (section === 'global') {
      setAllowKey(config.global, key, value, lineNo);
    } else if (section === 'ruleAllow') {
      setAllowKey(allow!, key, value, lineNo);
    } else {
      if (!RULE_KEYS.has(key)) throw new RulepackError(`unknown rule field "${key}"`, lineNo);
      const r = rule!;
      if (key === 'keywords') r.keywords = strList(value, key, lineNo);
      else if (key === 'entropy' || key === 'secretGroup') {
        if (typeof value !== 'number') throw new RulepackError(`"${key}" must be a number`, lineNo);
        r[key] = value;
      } else if (key === 'id' || key === 'description' || key === 'regex' || key === 'path') {
        if (typeof value !== 'string') throw new RulepackError(`"${key}" must be a string`, lineNo);
        r[key] = value;
      }
    }
  }
  for (const r of config.rules) if (!r.id) throw new RulepackError('a rule has no id');
  return config;
}

// --- Go RE2 -> JavaScript ----------------------------------------------------

const POSIX: Record<string, string> = {
  alnum: 'a-zA-Z0-9',
  alpha: 'a-zA-Z',
  digit: '0-9',
  lower: 'a-z',
  upper: 'A-Z',
  space: '\\s',
  xdigit: '0-9a-fA-F',
  word: '\\w',
  punct: '!-\\/:-@\\[-`{-~',
};

function isLetter(ch: string): boolean {
  return /^[A-Za-z]$/.test(ch);
}

function swapCase(ch: string): string {
  return ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
}

/**
 * Translates one class body (between the brackets) and returns the JS class.
 * Under case-insensitivity every letter and letter range gains its other case.
 */
function translateClass(src: string, start: number, ci: boolean): { out: string; end: number } {
  let i = start + 1;
  let head = '[';
  if (src[i] === '^') {
    head += '^';
    i++;
  }
  let out = '';
  const extra: string[] = [];
  let first = true;
  while (i < src.length) {
    const ch = src[i]!;
    // Go reads a `]` first in a class as a literal; JavaScript reads `[^]` as
    // "any character", which would turn an allowlist into allow-everything.
    // The other-case letters go FIRST: appended last they would follow a
    // trailing `-` (`[a-z_-]`) and turn it into a range.
    if (ch === ']' && !first) return { out: head + extra.join('') + out + ']', end: i + 1 };
    first = false;
    if (ch === '[' && src[i + 1] === ':') {
      const close = src.indexOf(':]', i + 2);
      const name = src.slice(i + 2, close);
      const body = POSIX[name];
      if (close < 0 || body === undefined) throw new Error(`POSIX class [:${name}:]`);
      out += body;
      i = close + 2;
      continue;
    }
    if (ch === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === ']' || ch === '[') {
      out += '\\' + ch;
      i++;
      continue;
    }
    // A range a-z.
    if (src[i + 1] === '-' && src[i + 2] !== undefined && src[i + 2] !== ']') {
      const lo = ch;
      const hi = src[i + 2]!;
      out += `${lo}-${hi}`;
      if (
        ci &&
        isLetter(lo) &&
        isLetter(hi) &&
        (lo === lo.toLowerCase()) === (hi === hi.toLowerCase())
      ) {
        extra.push(`${swapCase(lo)}-${swapCase(hi)}`);
      }
      i += 3;
      continue;
    }
    out += ch;
    if (ci && isLetter(ch)) extra.push(swapCase(ch));
    i++;
  }
  throw new Error('unterminated character class');
}

/**
 * Go RE2 source -> JavaScript source (no flags). Case-insensitive regions are
 * spelled out letter by letter ([aA]) because JavaScript in this Node has no
 * inline modifiers; that is exact for ASCII, which is all these rules match.
 */
export function translateGoRegex(src: string): string {
  let out = '';
  // Flag state per open group; a mid-group (?i) lasts to that group's end.
  const stack: { ci: boolean; dotall: boolean }[] = [{ ci: false, dotall: false }];
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  while (i < src.length) {
    const ch = src[i]!;
    const { ci, dotall } = top();
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === 'z')
        out += '$'; // Go: end of text; JS without m: the same
      else if (next === 'A') out += '^';
      else if (next === 'x' && src[i + 2] === '{') throw new Error('\\x{...} needs the u flag');
      else out += src.slice(i, i + 2); // \s \w \b \x60 \. ...: no case to fold
      i += 2;
      continue;
    }
    if (ch === '[') {
      const cls = translateClass(src, i, ci);
      out += cls.out;
      i = cls.end;
      continue;
    }
    if (ch === '(') {
      if (src[i + 1] !== '?') {
        stack.push({ ci, dotall });
        out += '(';
        i++;
        continue;
      }
      const m = /^\(\?(?:P?<([A-Za-z_]\w*)>|([imsU-]*)(:|\)))/.exec(src.slice(i));
      if (!m) throw new Error(`group syntax at "${src.slice(i, i + 8)}"`);
      if (m[1] !== undefined) {
        stack.push({ ci, dotall });
        out += `(?<${m[1]}>`;
        i += m[0].length;
        continue;
      }
      const flags = m[2]!;
      if (flags.includes('U') || flags.includes('m')) throw new Error(`flag (?${flags})`);
      const [on, off = ''] = flags.split('-');
      const next = {
        ci: off.includes('i') ? false : on!.includes('i') ? true : ci,
        dotall: off.includes('s') ? false : on!.includes('s') ? true : dotall,
      };
      if (m[3] === ':') {
        stack.push(next);
        out += '(?:';
      } else {
        stack[stack.length - 1] = next; // (?i) to the end of this group
      }
      i += m[0].length;
      continue;
    }
    if (ch === ')') {
      if (stack.length === 1) throw new Error('unbalanced )');
      stack.pop();
      out += ')';
      i++;
      continue;
    }
    if (ch === '.' && dotall) out += '[\\s\\S]';
    else if (ci && isLetter(ch)) out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    else out += ch;
    i++;
  }
  if (stack.length !== 1) throw new Error('unbalanced (');
  return out;
}

/** Compiles a Go pattern; the error names the construct it could not take. */
export function goRegExp(src: string, flags = ''): RegExp {
  return new RegExp(translateGoRegex(src), flags);
}

// --- Rules ---------------------------------------------------------------------

export interface SkippedGitleaksRule {
  id: string;
  reason: string;
}

export interface CompiledGitleaks {
  rules: SecretRule[];
  skipped: SkippedGitleaksRule[];
}

interface CompiledAllowlist {
  regexes: RegExp[];
  target: 'secret' | 'match' | 'line';
  stopwords: string[];
  paths: RegExp[];
  and: boolean;
}

function compileAllowlist(a: GitleaksAllowlist): CompiledAllowlist {
  return {
    regexes: a.regexes.map((r) => goRegExp(r)),
    target: a.regexTarget ?? 'secret',
    stopwords: a.stopwords.map((s) => s.toLowerCase()),
    paths: a.paths.map((p) => goRegExp(p)),
    and: a.condition === 'AND',
  };
}

interface Hit {
  secret: string;
  match: string;
  line: string;
  file: string;
}

/** gitleaks' allowlist test: any criterion (OR, the default) or all present (AND). */
function allowlisted(a: CompiledAllowlist, hit: Hit): boolean {
  const target = a.target === 'line' ? hit.line : a.target === 'match' ? hit.match : hit.secret;
  const checks: boolean[] = [];
  if (a.regexes.length) checks.push(a.regexes.some((r) => r.test(target)));
  if (a.stopwords.length) {
    const lower = hit.secret.toLowerCase();
    checks.push(a.stopwords.some((s) => lower.includes(s)));
  }
  if (a.paths.length) checks.push(a.paths.some((p) => p.test(hit.file)));
  if (checks.length === 0) return false;
  return a.and ? checks.every(Boolean) : checks.some(Boolean);
}

/** Credential family for chaining and titles: the id's first word. */
function kindOf(id: string): string {
  return id.split('-')[0]!.replace(/[^a-z0-9_]/g, '_');
}

export interface CompileGitleaksOptions {
  /** Ids we already ship: our own rule covers it, so theirs is not loaded. */
  ours: ReadonlySet<string>;
}

/**
 * gitleaks rules as shadow SecretRules. A rule that cannot run here is
 * skipped WITH ITS REASON (the ledger and the tests list them) rather than
 * loaded half-working: a path-only rule, or one our id already covers.
 */
export function compileGitleaks(
  config: GitleaksConfig,
  opts: CompileGitleaksOptions,
): CompiledGitleaks {
  const skipped: SkippedGitleaksRule[] = [];
  const rules: SecretRule[] = [];
  const global = compileAllowlist(config.global);

  for (const r of config.rules) {
    if (opts.ours.has(r.id)) {
      skipped.push({ id: r.id, reason: 'our rule of the same id covers it' });
      continue;
    }
    if (r.regex === undefined) {
      skipped.push({ id: r.id, reason: 'matches a file name only; this scanner reads content' });
      continue;
    }
    let regex: RegExp;
    let allowlists: CompiledAllowlist[];
    let pathRe: RegExp | undefined;
    try {
      regex = goRegExp(r.regex, 'g');
      allowlists = r.allowlists.map(compileAllowlist);
      if (r.path !== undefined) pathRe = goRegExp(r.path);
    } catch (err) {
      skipped.push({ id: r.id, reason: `regex: ${(err as Error).message}` });
      continue;
    }
    const generic = r.id.startsWith('generic');
    const floor = r.entropy;
    const group = r.secretGroup;

    rules.push({
      id: r.id,
      description: r.description,
      kind: kindOf(r.id),
      // Unmeasured on our customers' code: a middle severity until a rule is
      // promoted on evidence, and it is a shadow candidate either way.
      severity: 3,
      regex,
      keywords: r.keywords,
      allowlist: [],
      candidate: true,
      yieldsToSpecific: generic,
      secretOf: (m) => {
        if (group !== undefined && group > 0) return m[group] ?? '';
        for (let g = 1; g < m.length; g++) if (m[g]) return m[g]!;
        return m[0];
      },
      keep: (hit) => {
        // gitleaks' inline opt-out: a person already looked at this line.
        if (hit.line.includes('gitleaks:allow')) return false;
        if (pathRe && !pathRe.test(hit.file)) return false;
        if (floor !== undefined) {
          if (shannonEntropy(hit.secret) <= floor) return false;
          if (generic && !/\d/.test(hit.secret)) return false;
        }
        if (allowlisted(global, hit)) return false;
        return !allowlists.some((a) => allowlisted(a, hit));
      },
    });
  }
  return { rules, skipped };
}

export const GITLEAKS_TOML = (thirdPartyDir: string): string =>
  path.join(thirdPartyDir, 'gitleaks', 'config', 'gitleaks.toml');

export function loadGitleaks(file: string, ours: ReadonlySet<string>): CompiledGitleaks {
  return compileGitleaks(parseGitleaksToml(readFileSync(file, 'utf8')), { ours });
}
