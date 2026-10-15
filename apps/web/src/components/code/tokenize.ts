// A small, dependency-free tokenizer for the code and diff views (W18-30).
//
// It returns plain {text, kind} pieces that React renders as text nodes. It
// never builds an HTML string, so nothing a finding quotes can inject markup:
// this is a security product and the text it shows is, by definition, hostile.
//
// It is deliberately approximate: keywords, strings, numbers, comments, calls
// and capitalised type names. That is enough to make a quoted line scannable.
// Swapping in a full grammar highlighter later only has to replace
// `tokenizeLines`; the components consume `Token[][]` and do not care.

export type TokenKind =
  | 'kw'
  | 'str'
  | 'num'
  | 'com'
  | 'fn'
  | 'type'
  | 'punct'
  | 'hidden'
  | 'plain';

export interface Token {
  text: string;
  kind: TokenKind;
}

interface Lang {
  keywords: ReadonlySet<string>;
  line: readonly string[];
  block?: readonly [string, string];
  quotes: string;
}

const set = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const JS = set(
  'async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of return static super switch this throw true try type typeof undefined var void while with yield as readonly public private protected abstract declare namespace',
);
const PY = set(
  'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self',
);
const GO = set(
  'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
);
const JAVA = set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws transient true false try var void volatile while record',
);
const RUBY = set(
  'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield',
);
const RUST = set(
  'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
);
const SHELL = set(
  'if then else elif fi for while until do done case esac function in select time export local readonly return exit',
);
const SQL = set(
  'select from where and or not insert into values update set delete create table drop alter join left right inner outer on group by order having limit as in is null like union distinct case when then else end',
);
const PHP = set(
  'abstract and array as break case catch class clone const continue declare default do echo else elseif empty extends final finally for foreach function global if implements include instanceof interface isset namespace new null or print private protected public require return static switch throw trait try unset use var while yield true false',
);

const C_LIKE = { line: ['//'], block: ['/*', '*/'] as const, quotes: '"\'`' };

const LANGS: Record<string, Lang> = {
  js: { keywords: JS, ...C_LIKE },
  py: { keywords: PY, line: ['#'], quotes: '"\'' },
  go: { keywords: GO, ...C_LIKE },
  java: { keywords: JAVA, line: ['//'], block: ['/*', '*/'], quotes: '"\'' },
  rb: { keywords: RUBY, line: ['#'], quotes: '"\'' },
  rs: { keywords: RUST, line: ['//'], block: ['/*', '*/'], quotes: '"\'' },
  sh: { keywords: SHELL, line: ['#'], quotes: '"\'' },
  sql: { keywords: SQL, line: ['--'], block: ['/*', '*/'], quotes: "'\"" },
  php: { keywords: PHP, line: ['//', '#'], block: ['/*', '*/'], quotes: '"\'' },
  yaml: { keywords: set('true false null yes no'), line: ['#'], quotes: '"\'' },
  json: { keywords: set('true false null'), line: [], quotes: '"' },
};

const EXT: Record<string, keyof typeof LANGS> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', go: 'go', java: 'java', kt: 'java', cs: 'java', c: 'java', h: 'java', cpp: 'java',
  rb: 'rb', rs: 'rs', sh: 'sh', bash: 'sh', sql: 'sql', php: 'php',
  yaml: 'yaml', yml: 'yaml', json: 'json',
};

/** The language key for a path, or null when it is not one we colour. */
export function languageFor(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return base === 'Dockerfile' ? 'sh' : null;
  return EXT[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** Short label for the header chip ("TS", "PY"), '' for unknown. */
export function languageLabel(path: string | null | undefined): string {
  if (!path) return '';
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toUpperCase().slice(0, 4);
}

// Characters that change what a reader sees without being visible. Showing
// them is the Trojan-Source defence: bidi controls reorder code on screen, and
// zero-width characters hide inside identifiers.
const HIDDEN = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\u2060\ufeff\u00ad]/;
const HIDDEN_G = new RegExp(HIDDEN.source, 'g');

/** True when the text holds any invisible control or zero-width character. */
export function hasHiddenChars(text: string): boolean {
  return HIDDEN.test(text);
}

function codePointLabel(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Split a token so every hidden character becomes its own visible token. */
function revealHidden(t: Token): Token[] {
  if (!HIDDEN.test(t.text)) return [t];
  const out: Token[] = [];
  let last = 0;
  for (const m of t.text.matchAll(HIDDEN_G)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: t.text.slice(last, i), kind: t.kind });
    out.push({ text: `‹${codePointLabel(m[0])}›`, kind: 'hidden' });
    last = i + m[0].length;
  }
  if (last < t.text.length) out.push({ text: t.text.slice(last), kind: t.kind });
  return out;
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;

function tokenizeLine(
  line: string,
  lang: Lang,
  inBlock: boolean,
): { tokens: Token[]; inBlock: boolean } {
  const tokens: Token[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (text === '') return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.kind === kind) prev.text += text;
    else tokens.push({ text, kind });
  };
  let i = 0;
  while (i < line.length) {
    if (inBlock) {
      const end = lang.block ? line.indexOf(lang.block[1], i) : -1;
      if (end < 0) {
        push(line.slice(i), 'com');
        return { tokens, inBlock: true };
      }
      push(line.slice(i, end + lang.block![1].length), 'com');
      i = end + lang.block![1].length;
      inBlock = false;
      continue;
    }
    if (lang.block && line.startsWith(lang.block[0], i)) {
      inBlock = true;
      push(lang.block[0], 'com');
      i += lang.block[0].length;
      continue;
    }
    const lc = lang.line.find((c) => line.startsWith(c, i));
    if (lc) {
      push(line.slice(i), 'com');
      break;
    }
    const ch = line[i]!;
    if (lang.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      push(line.slice(i, Math.min(j + 1, line.length)), 'str');
      i = Math.min(j + 1, line.length);
      continue;
    }
    if (/\d/.test(ch)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(line);
      if (m) {
        push(m[0], 'num');
        i += m[0].length;
        continue;
      }
    }
    IDENT.lastIndex = i;
    const id = IDENT.exec(line);
    if (id) {
      const w = id[0];
      const after = line[i + w.length];
      const kind: TokenKind = lang.keywords.has(w)
        ? 'kw'
        : after === '('
          ? 'fn'
          : /^[A-Z]/.test(w) && /[a-z]/.test(w)
            ? 'type'
            : 'plain';
      push(w, kind);
      i += w.length;
      continue;
    }
    push(ch, /[\s\w]/.test(ch) ? 'plain' : 'punct');
    i += 1;
  }
  return { tokens, inBlock };
}

/**
 * One token list per input line. An unknown language still gets hidden-char
 * reveal, so the Trojan-Source defence does not depend on a language match.
 */
export function tokenizeLines(lines: readonly string[], language: string | null): Token[][] {
  const lang = language ? LANGS[language] : undefined;
  let inBlock = false;
  return lines.map((line) => {
    if (!lang) return revealHidden({ text: line, kind: 'plain' });
    const r = tokenizeLine(line, lang, inBlock);
    inBlock = r.inBlock;
    return r.tokens.flatMap(revealHidden);
  });
}
