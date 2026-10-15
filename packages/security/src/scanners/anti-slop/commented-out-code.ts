import { lex, type CommentLine, type Family } from './leftovers-lex.js';

// Commented-out code (W18-07, mechanical-checks plan §D).
//
// An assistant asked to change an approach often keeps the old one "for
// reference" — as a comment block nobody will uncomment and nobody dares
// delete. Version control already keeps the old version; the comment keeps
// only the confusion.
//
// A RUN, NOT A LINE. One `// foo();` is a note about a call; three code-shaped
// lines in a row is a block of code. A run needs at least three code lines,
// two of them unambiguous statements (a lone `}` or `else:` is code-shaped
// but says nothing on its own).
//
// WHAT IS NOT COMMENTED-OUT CODE: doc comments (`/** */` — they carry usage
// examples on purpose), any block that says it is an example (@example,
// ``` fences, doctest `>>>`, "e.g.", "usage:"), licence headers, and ASCII
// diagrams. Each of those is code-shaped text written to be read.

export const COMMENTED_CODE_RULE_ID = 'slop.commented_out_code';

export interface CommentedCodeFinding {
  ruleId: typeof COMMENTED_CODE_RULE_ID;
  file: string;
  line: number;
  lineEnd: number;
  /** The first code line of the run, as it appears in the file. */
  firstLine: string;
  codeLines: number;
  message: string;
}

/** Paths whose comments are expected to hold code. */
const SKIP_PATH =
  /(^|\/)(fixtures?|__fixtures__|testdata|examples?|samples?|docs?|documentation|tutorials?|vendor|third[_-]?party|generated|__generated__)\/|\.min\.[cm]?js$|\.d\.ts$|\.(example|sample|template)\.\w+$/i;

const MIN_RUN = 3;
const MIN_STRONG = 2;

type Shape = 'strong' | 'weak' | 'blank' | 'prose';

/** Do the brackets in this line close everything they open, in order? */
export function balanced(text: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (const c of text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""')) {
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c in pairs) {
      if (stack.pop() !== pairs[c]) return false;
    }
  }
  return stack.length === 0;
}

/** Three or more plain words in a row with no operator between them. */
const PROSE_RUN = /(?:^|[\s(])[A-Za-z][a-z']*(?: [A-Za-z][a-z']*,?){3,}/;

/** Code operators that a sentence rarely carries. */
const CODE_PUNCT = /[=;{}()[\]]|=>|->|::|\.\w/;

/** Tool directives and pragmas: code-shaped by design, and meant to stay. */
const DIRECTIVE =
  /^(?:eslint|prettier|istanbul|c8|@ts-|tslint|jshint|global\s|type:|noqa|pylint|mypy|fmt:|pragma|nolint|go:|\+build|-\*-|!\/|region\b|endregion\b)/;

const NOTE = /^(?:TODO|FIXME|NOTE|XXX|HACK|BUG|WARN(?:ING)?|SAFETY|NB)\b/i;

export function braceShape(text: string): Shape {
  const t = text.trim();
  if (t === '') return 'blank';
  if (DIRECTIVE.test(t)) return 'prose';
  if (NOTE.test(t) || t.startsWith('@') || (/[.?!]$/.test(t) && !t.endsWith('...'))) return 'prose';
  if (/^[}\])]+[;,)]*$/.test(t)) return 'weak';
  if (/^(?:\}\s*)?(?:else|try|finally|do)\s*\{$/.test(t) || /^(?:break|continue);?$/.test(t))
    return 'weak';
  if (/^(?:case\s+[^:]+|default)\s*:$/.test(t)) return 'weak';

  const statement = /[;{]$/.test(t) || /\)$/.test(t);
  if (
    /^(?:const|let|var)\s+[\w$[{][^=]*=\s*\S/.test(t) &&
    !PROSE_RUN.test(t.split('=').slice(1).join('='))
  )
    return 'strong';
  if (/^(?:const|let|var)\s+[\w$]+\s*;$/.test(t)) return 'strong';
  if (/^(?:if|for|while|switch|catch)\s*\(.*\)\s*\{?$/.test(t) && balanced(t.replace(/\{$/, '')))
    return 'strong';
  if (/^\}\s*(?:else(?:\s+if\s*\(.*\))?|catch\s*\(.*\)|finally)\s*\{$/.test(t)) return 'strong';
  if (/^(?:return|throw)(?:\s+.+)?;$/.test(t) || t === 'return;') return 'strong';
  if (/^import\s+(?:[\w${}*,\s]+\s+from\s+)?['"][^'"]+['"];?$/.test(t)) return 'strong';
  if (/^export\s+(?:default\s+|const\s+\w|function\s+\w|class\s+\w|\{)/.test(t) && statement)
    return 'strong';
  if (/^(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(.*\)\s*\{$/.test(t)) return 'strong';
  if (/^(?:export\s+)?(?:abstract\s+)?class\s+[\w$]+.*\{$/.test(t)) return 'strong';
  if (/^(?:public|private|protected|static|func|fn|def)\b.*\(.*\).*\{$/.test(t)) return 'strong';
  if (/=>\s*\{$/.test(t) && t.includes('(')) return 'strong';
  // Go short declarations and Rust lets end without a semicolon.
  if (/^[\w$]+(?:\s*,\s*[\w$]+)*\s*:=\s*\S/.test(t)) return 'strong';
  if (/^if\s+.+\{$/.test(t) && /(?:!=|==|:=|&&|\|\||<|>)/.test(t)) return 'strong';

  const assign =
    /^(?:await\s+)?[\w$]+(?:\.[\w$]+|\[[^\]]+\])*\s*(?:[-+*/%|&^]|\?\?|\|\||&&|<<|>>)?=\s*([^=\s].*)$/.exec(
      t,
    );
  if (assign && /[;,)\]}{('"\w]$/.test(t) && !PROSE_RUN.test(assign[1] as string)) {
    // `x = the count of rows` is prose with an equals sign; a value with a
    // statement end or code punctuation is not.
    if (
      t.endsWith(';') ||
      CODE_PUNCT.test(assign[1] as string) ||
      /^['"\d-]|^(?:true|false|null|undefined|new\s)/.test(assign[1] as string)
    )
      return 'strong';
  }
  const call = /^(?:await\s+|void\s+)?([\w$]+(?:\??\.[\w$]+|\(\))*)\s*\((.*)\)\s*;?$/.exec(t);
  if (call && balanced(t) && !/\s/.test(call[1] as string)) {
    if (
      t.endsWith(';') ||
      (call[1] as string).includes('.') ||
      /[A-Z_]/.test((call[1] as string).slice(1))
    )
      return 'strong';
  }
  if (t.endsWith(';') && CODE_PUNCT.test(t) && !PROSE_RUN.test(t) && balanced(t)) return 'strong';
  // Object literal properties and chained calls continue a statement.
  if (/^[\w$'"]+\s*:\s*[^:]+,$/.test(t) && !PROSE_RUN.test(t)) return 'weak';
  if (/^\.[\w$]+\(.*\)?[;,]?$/.test(t)) return 'weak';
  return 'prose';
}

const PY_KEYWORD_BLOCK = /^(?:if|elif|while|for|with|except|async\s+with|async\s+for)\b.*:$/;

export function hashShape(text: string): Shape {
  const t = text.trim();
  if (t === '') return 'blank';
  if (DIRECTIVE.test(t) || NOTE.test(t) || /[.?!]$/.test(t)) return 'prose';
  if (/^(?:else|try|finally|except)\s*:$/.test(t) || /^(?:pass|break|continue|return|end)$/.test(t))
    return 'weak';
  if (/^[}\])]+,?$/.test(t)) return 'weak';
  if (/^(?:async\s+)?def\s+\w+\s*\(.*\)?\s*(?:->\s*[^:]+)?:$/.test(t)) return 'strong';
  if (/^class\s+\w+(?:\(.*\))?\s*:$/.test(t)) return 'strong';
  if (
    /^import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*$/.test(t) ||
    /^from\s+\.*[\w.]*\s+import\s+(?:\(|\*|[\w]+(?:\s+as\s+\w+)?(?:\s*,\s*\w+(?:\s+as\s+\w+)?)*,?)$/.test(
      t,
    )
  )
    return 'strong';
  if (/^(?:return|raise|yield|await|assert|del)\s+\S/.test(t)) {
    const rest = t.replace(/^\w+\s+/, '');
    return PROSE_RUN.test(rest) || (!CODE_PUNCT.test(rest) && /\s/.test(rest)) ? 'prose' : 'strong';
  }
  if (PY_KEYWORD_BLOCK.test(t)) {
    if (/^for\s+[\w, ()]+\s+in\s+\S.*:$/.test(t) && !PROSE_RUN.test(t.slice(4))) return 'strong';
    if (/[()[\].=<>!]/.test(t) && balanced(t)) return 'strong';
    // `if x is not None:` is code; `if you want:` is a sentence. Neither is
    // decisive alone, so it counts towards a run but not as a statement.
    return /^(?:if|elif|while)\s+\w+(?:\s+(?:is|not|and|or|in|None|True|False|\w+))*:$/.test(t) &&
      !PROSE_RUN.test(t)
      ? 'weak'
      : 'prose';
  }
  const assign =
    /^[\w.]+(?:\[[^\]]*\])*(?:\s*,\s*[\w.]+)*\s*(?:[-+*/%|&^@]|\/\/|\*\*|<<|>>)?=\s*([^=\s].*)$/.exec(
      t,
    );
  if (assign && balanced(t) && !PROSE_RUN.test(assign[1] as string)) return 'strong';
  const call = /^(?:await\s+)?([\w.]+)\((.*)\)$/.exec(t);
  if (call && balanced(t) && ((call[1] as string).includes('.') || (call[2] as string).length > 0))
    return PROSE_RUN.test(call[2] as string) ? 'prose' : 'strong';
  if (/^@[\w.]+(?:\(.*\))?$/.test(t)) return 'weak';
  // Dict entries and call arguments continued over lines.
  if (/^['"]?[\w-]+['"]?\s*[:=]\s*[^:]+,$/.test(t) && !PROSE_RUN.test(t)) return 'weak';
  return 'prose';
}

/** The whole group is something other than code that was switched off. */
function excludedGroup(lines: readonly CommentLine[]): boolean {
  const text = lines.map((l) => l.text).join('\n');
  if (lines.some((l) => l.doc)) return true;
  if (
    /\b(?:licen[cs]e|copyright|spdx|warrant|permission is hereby|all rights reserved)\b/i.test(text)
  )
    return true;
  if (/@example|```|<pre>|<code>|>>>|^\s*\$ /im.test(text)) return true;
  if (
    /(?:\be\.g\.|\bi\.e\.|\bexample\b|\busage\b|\bfor instance\b|\blike (?:so|this)\b|\bsuch as\b|\bequivalent\b|\bsimilar to\b)/i.test(
      text,
    )
  )
    return true;
  // ASCII diagrams: box drawing, `+---+` frames, `|  x  |` rows, arrows.
  const diagram = lines.filter((l) =>
    /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝]|\+-{2,}|-{2,}\+|-{2,}>|<-{2,}|^\s*\|.*\|\s*$|^\s*[|v^]\s*$/.test(l.text),
  ).length;
  if (diagram >= 2) return true;
  // Grammars (ABNF/BNF) assign and alternate like code; shell recipes for
  // regenerating a file are instructions. Neither was ever running code.
  if (/%x[0-9A-Fa-f]|(?:^|[\s(])\d*\*\d*\(|\b(?:ALPHA|DIGIT|HEXDIG|CRLF)\b|::=/.test(text))
    return true;
  if (
    /^\s*(?:\$\s|python3?\s+-|pip3?\s|npm\s|npx\s|node\s+-|bash\s|sh\s+-|curl\s|git\s)/m.test(text)
  )
    return true;
  return false;
}

const indentOf = (text: string): number => (/^\s*/.exec(text)?.[0] ?? '').length;

/**
 * A sentence that hands over to code is showing it, not keeping it: "For
 * exposition, write:" followed by statements, or prose followed by code
 * indented under it the way Markdown and reST set off an example.
 */
function introduces(prose: CommentLine | null, first: CommentLine): boolean {
  if (!prose) return false;
  if (prose.text.trimEnd().endsWith(':')) return true;
  return indentOf(first.text) >= indentOf(prose.text) + 2;
}

function shapeOf(family: Family): (text: string) => Shape {
  return family === 'hash' ? hashShape : braceShape;
}

export function commentedOutCode(
  files: readonly { path: string; source: string }[],
): CommentedCodeFinding[] {
  const out: CommentedCodeFinding[] = [];
  for (const file of files) {
    if (SKIP_PATH.test(file.path)) continue;
    const lexed = lex(file.path, file.source);
    if (!lexed) continue;
    const shape = shapeOf(lexed.family);

    const groups = new Map<number, CommentLine[]>();
    for (const c of lexed.comments) {
      if (!c.whole) continue;
      const g = groups.get(c.group);
      if (g) g.push(c);
      else groups.set(c.group, [c]);
    }

    for (const lines of groups.values()) {
      if (lines.length < MIN_RUN || excludedGroup(lines)) continue;
      // One finding per comment block: a disabled function reads as several
      // runs (its `data: {` lines are not statements), and five findings
      // for one block would be five triage decisions for one deletion.
      let run: CommentLine[] = [];
      let strong = 0;
      let lastProse: CommentLine | null = null;
      let introducer: CommentLine | null = null;
      const kept: CommentLine[] = [];
      const flush = (): void => {
        if (
          run.length >= MIN_RUN &&
          strong >= MIN_STRONG &&
          !introduces(introducer, run[0] as CommentLine)
        ) {
          kept.push(...run);
        }
        run = [];
        strong = 0;
      };
      for (const line of lines) {
        const s = shape(line.text);
        if (s === 'blank') continue;
        if (s === 'prose') {
          flush();
          lastProse = line;
          continue;
        }
        if (run.length === 0) introducer = lastProse;
        run.push(line);
        if (s === 'strong') strong++;
      }
      flush();
      const first = kept[0];
      const last = kept[kept.length - 1];
      if (first && last) {
        const codeLines = kept.length;
        out.push({
          ruleId: COMMENTED_CODE_RULE_ID,
          file: file.path,
          line: first.line,
          lineEnd: last.line,
          firstLine: (lexed.lines[first.line - 1] ?? '').trim(),
          codeLines,
          message: `${codeLines} comment lines read as code: commented-out code that version control already keeps — delete it, or restore it if it is still needed.`,
        });
      }
    }
  }
  return out;
}
