import { lex } from './leftovers-lex.js';
import {
  DEPRECATED_APIS,
  DEPRECATED_API_TABLE_VERSION,
  type DeprecatedApi,
} from './deprecated-apis.v1.js';

// Deprecated APIs (W18-07, mechanical-checks plan §A). The table is the rule;
// this file only applies it. See deprecated-apis.v1.ts for why every entry
// carries its official source.
//
// IN-PROCESS, NOT SEMGREP. The entries are one-token patterns plus an import
// gate and a nearby-replacement check — what a regex over the shared masked
// view answers exactly — and the fast lane runs on every snapshot without a
// subprocess. A Semgrep pack would also sit behind the code-health pack's
// surfacing path (W18-30), so its findings would not be seen at all yet.

export const DEPRECATED_API_RULE_ID = 'slop.deprecated_api';
export { DEPRECATED_API_TABLE_VERSION };

export interface DeprecatedApiFinding {
  ruleId: typeof DEPRECATED_API_RULE_ID;
  file: string;
  line: number;
  entry: DeprecatedApi;
  /** The line, verbatim and trimmed. */
  statement: string;
  message: string;
}

/** Paths that exist to show or test old behaviour on purpose. */
const SKIP_PATH =
  /(^|\/)(fixtures?|__fixtures__|testdata|examples?|samples?|docs?|documentation|vendor|_vendor|vendored|_distutils|third[_-]?party|compat|legacy|polyfills?|shims?)\/|(^|\/)[^/]*compat[^/]*\.\w+$|\.min\.[cm]?js$|\.d\.ts$/i;

const COMPAT_WINDOW = 10;

const indentOf = (s: string): number =>
  (/^[ \t]*/.exec(s)?.[0] ?? '').replace(/\t/g, '    ').length;

/**
 * The block headers enclosing a Python line, innermost first. Python's block
 * structure is indentation, so each is the nearest earlier line indented less
 * than everything after it.
 */
function enclosingHeaders(codeLines: readonly string[], line: number): string[] {
  const out: string[] = [];
  let limit = indentOf(codeLines[line - 1] ?? '');
  for (let n = line - 2; n >= 0 && limit > 0; n--) {
    const text = codeLines[n] ?? '';
    if (text.trim() === '') continue;
    const indent = indentOf(text);
    if (indent >= limit) continue;
    limit = indent;
    // `) -> None:` closes a signature spread over lines; the header is the
    // `def` that opened it, the nearest line above at the same indentation.
    if (/^\s*\)/.test(text)) {
      let k = n - 1;
      while (
        k >= 0 &&
        ((codeLines[k] ?? '').trim() === '' || indentOf(codeLines[k] ?? '') !== indent)
      )
        k--;
      if (k >= 0) {
        n = k;
        out.push((codeLines[k] ?? '').trim());
        continue;
      }
    }
    out.push(text.trim());
  }
  return out;
}

/**
 * `get_event_loop()` is deprecated only where no loop is running, and whether
 * one is running is a runtime fact. Read conservatively: module and class
 * level, and functions named as entry points, run before any loop exists; a
 * method called from a coroutine is the common case elsewhere and is left
 * alone.
 */
function outsideRunningLoop(headers: readonly string[]): boolean {
  const def = headers.find((h) => /^(?:async\s+)?def\b/.test(h));
  if (!def) return true;
  if (def.startsWith('async')) return false;
  return /^def\s+(?:main|run|cli|start|entry(?:_?point)?)\s*\(/.test(def);
}

/** `try: import imp / except ImportError: …` — a fallback, written on purpose. */
function insideImportFallback(headers: readonly string[]): boolean {
  const h = headers[0];
  return (
    h !== undefined &&
    (/^try\s*:/.test(h) || /^except\b.*\b(?:ImportError|ModuleNotFoundError)\b/.test(h))
  );
}

export function deprecatedApis(
  files: readonly { path: string; source: string }[],
  table: readonly DeprecatedApi[] = DEPRECATED_APIS,
): DeprecatedApiFinding[] {
  const out: DeprecatedApiFinding[] = [];
  for (const file of files) {
    if (SKIP_PATH.test(file.path)) continue;
    const lexed = lex(file.path, file.source);
    if (!lexed) continue;
    const seen = new Set<string>();
    let strippedLines: string[] | null = null;
    let codeLines: string[] | null = null;
    for (const entry of table) {
      if (entry.language !== lexed.lang) continue;
      if (entry.requires && !entry.requires.test(lexed.withStrings)) continue;
      const pattern = new RegExp(
        entry.pattern.source,
        entry.pattern.flags.includes('g') ? entry.pattern.flags : `${entry.pattern.flags}g`,
      );
      for (const m of lexed.withStrings.matchAll(pattern)) {
        // Leading whitespace in a line-anchored pattern is not the start.
        const at = m.index + (m[0].length - m[0].trimStart().length);
        if (lexed.code[at] !== file.source[at] || /\s/.test(lexed.code[at] ?? ' ')) continue;
        const line = lexed.lineOf(at);
        const key = `${entry.id}:${line}`;
        if (seen.has(key)) continue;
        if (entry.compat) {
          strippedLines ??= lexed.withStrings.split('\n');
          const window = strippedLines
            .slice(Math.max(0, line - 1 - COMPAT_WINDOW), line + COMPAT_WINDOW)
            .join('\n');
          if (entry.compat.test(window)) continue;
        }
        if (lexed.lang === 'python') {
          const headers = enclosingHeaders((codeLines ??= lexed.code.split('\n')), line);
          if (insideImportFallback(headers)) continue;
          if (entry.judge === 'outside_running_loop' && !outsideRunningLoop(headers)) continue;
        }
        seen.add(key);
        out.push({
          ruleId: DEPRECATED_API_RULE_ID,
          file: file.path,
          line,
          entry,
          statement: (lexed.lines[line - 1] ?? '').trim().slice(0, 200),
          message: `Deprecated API (${entry.id}): use ${entry.replacement}. Source: ${entry.source}`,
        });
      }
    }
  }
  return out;
}
