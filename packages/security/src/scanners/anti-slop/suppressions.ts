import { isGenerated } from '@repopulse/analysis';
import { maskSource } from './source-graph.js';

// Suppression density (W18-04, mechanical-checks plan §A).
//
// Every type checker and linter has an off switch, and each use of one is a
// place where the tool was told to stop looking. One is a decision; dozens per
// thousand lines is a codebase that makes its checks pass by silencing them —
// the shape generated code takes when "make the build green" is the goal. So
// this rule measures a RATE, never a single hit: Biome's noExplicitAny and the
// linters' own unused-directive checks already report hits one by one.
//
// WHERE THE MARKERS LIVE. Half of them are comments (`// @ts-ignore`, `# noqa`,
// `//nolint`), so the usual move of masking comments before matching would
// throw away exactly what is being counted. Each language is lexed into its
// code, and its comments as separate spans, and a directive counts only at the
// START of a comment — which is where every tool that honours one looks for
// it. That is what keeps prose about a directive (this file, say) from being
// counted as one, and a marker inside a string literal never reaches either.

export const SUPPRESSION_DENSITY_RULE_ID = 'slop.suppression_density';

/**
 * Suppressions per thousand lines of code above which a codebase is reported.
 *
 * Measured, not guessed (W18-04, figures in plan.json), over product code —
 * tests, generated and vendored files excluded as below. Application code
 * sits near zero: this repository 0, CPython's asyncio 0.2, Debian's
 * dist-packages 0.4, Go's net and cmd/go 0. Typed libraries that do real
 * type-level work sit higher without being slop: the Anthropic SDK 6.4,
 * redocly openapi-core 10, TanStack router-core 11, zrender 13.3, and zod — a
 * library whose whole job is type gymnastics — 26.5 (v4) to 28.7 (v3).
 * Thirty clears every maintained codebase measured, so a repository over it is
 * silencing at a rate none of them does. Precision over recall: zod is the
 * nearest miss, and that margin is deliberate. Tunable per workspace, like
 * LDR_FLOOR: the scanner takes it as a parameter.
 */
export const SUPPRESSION_CEILING_PER_KLOC = 30;

/**
 * A file is reported on its own only when it is this many times denser than
 * the repository AND over the ceiling itself — an outlier, not merely a file
 * that has a few. Without the relative half, a repository at 25/KLOC would get
 * a finding on every file that happens to sit at 31.
 */
export const FILE_OUTLIER_FACTOR = 3;

/**
 * Fewest hits before a repository or file finding. A twenty-line file with
 * one `as any` is at 50/KLOC, and a density computed from a handful of events
 * is an anecdote: at three, the first measurement put seventeen small files of
 * the Anthropic SDK over the bar, none of them worth a reader's time.
 */
export const MIN_SUPPRESSION_HITS = 10;

/** A pull request is smaller, and new suppressions are cheapest to question before merge. */
export const MIN_PR_SUPPRESSION_HITS = 5;

/**
 * Tests, benchmarks and examples are left out of the count. `parse(42 as any)`
 * is how a test feeds a validator the wrong type on purpose; counting it would
 * make the best-tested code look the most silenced (zod's test files were
 * most of its outliers on the first measurement).
 */
const NOT_PRODUCT_CODE =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(_test\.(go|py)$)|((^|\/)test_[^/]*\.py$)|((^|\/)(__tests__|tests?|e2e|benchmarks?|examples?|_vendor|vendored|third_party)\/)/;

export type SuppressionKind =
  | 'as-any'
  | 'any-annotation'
  | 'any-type-argument'
  | 'ts-ignore'
  | 'ts-expect-error-no-reason'
  | 'ts-nocheck'
  | 'eslint-disable-file'
  | 'eslint-disable-line-no-rule'
  | 'biome-ignore-no-reason'
  | 'type-ignore-no-code'
  | 'noqa-bare'
  | 'pylint-disable-all'
  | 'nolint-bare'
  | 'crate-allow'
  | 'pragma-disable-warning'
  | 'suppress-warnings-all';

type Language = 'ts' | 'js' | 'python' | 'go' | 'rust' | 'c' | 'java';

export function languageOf(path: string): Language | null {
  if (/\.(ts|tsx|mts|cts)$/.test(path)) return 'ts';
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return 'js';
  if (/\.py$/.test(path)) return 'python';
  if (/\.go$/.test(path)) return 'go';
  if (/\.rs$/.test(path)) return 'rust';
  if (/\.(c|h|cc|cpp|cxx|hh|hpp|hxx)$/.test(path)) return 'c';
  if (/\.java$/.test(path)) return 'java';
  return null;
}

interface Lexed {
  /** Comments AND string contents blanked; offsets and newlines kept. */
  code: string;
  /** Comments blanked, strings kept — for markers whose argument is a string. */
  withStrings: string;
  comments: [number, number][];
}

/** Blanks [from, to) in a char array, keeping newlines so lines still count. */
function blankInto(out: string[], from: number, to: number): void {
  for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
}

/** End (exclusive) of a quoted literal opened at `i`. */
function quoted(
  source: string,
  i: number,
  close: string,
  multiline: boolean,
  escapes: boolean,
): number {
  let j = i + 1;
  while (j < source.length) {
    if (escapes && source[j] === '\\') {
      j += 2;
    } else if (source.startsWith(close, j)) {
      return j + close.length;
    } else if (!multiline && source[j] === '\n') {
      // An unterminated single-line literal ends at the line: running on would
      // swallow the rest of the file as string and hide everything in it.
      return j;
    } else {
      j++;
    }
  }
  return source.length;
}

const IDENT_CHAR = /[A-Za-z0-9_]/;

/** If a string literal starts at `i`, its end; otherwise null. */
function stringAt(lang: Exclude<Language, 'ts' | 'js'>, source: string, i: number): number | null {
  const c = source[i];
  const prev = i > 0 ? (source[i - 1] as string) : '';
  switch (lang) {
    case 'python':
      if (c !== '"' && c !== "'") return null;
      if (source.startsWith(c.repeat(3), i)) return quoted(source, i + 2, c.repeat(3), true, true);
      return quoted(source, i, c, false, true);
    case 'go':
      if (c === '"' || c === "'") return quoted(source, i, c, false, true);
      if (c === '`') return quoted(source, i, '`', true, false);
      return null;
    case 'java':
      if (c === '"' && source.startsWith('"""', i)) return quoted(source, i + 2, '"""', true, true);
      if (c === '"' || c === "'") return quoted(source, i, c, false, true);
      return null;
    case 'c':
      if (c === '"') return quoted(source, i, '"', false, true);
      // `1'000'000` is a C++14 digit separator, not a character literal.
      if (c === "'" && !/[0-9]/.test(prev)) return quoted(source, i, "'", false, true);
      return null;
    case 'rust': {
      if (c === 'r' && !IDENT_CHAR.test(prev === 'b' ? (source[i - 2] ?? '') : prev)) {
        const raw = /r(#*)"/y;
        raw.lastIndex = i;
        const m = raw.exec(source);
        if (m) {
          const close = `"${m[1] as string}`;
          const end = source.indexOf(close, i + m[0].length);
          return end === -1 ? source.length : end + close.length;
        }
        return null;
      }
      if (c === '"') return quoted(source, i, '"', true, true);
      if (c === "'") {
        // A char literal ('a', '\n', '\u{1F600}') or a lifetime ('a, 'static).
        // Only a closing quote close by tells them apart; a lifetime is code.
        if (source[i + 1] === '\\') {
          const end = source.indexOf("'", i + 2);
          return end !== -1 && end - i <= 12 ? end + 1 : null;
        }
        const cp = source.codePointAt(i + 1);
        const width = cp !== undefined && cp > 0xffff ? 2 : 1;
        return source[i + 1 + width] === "'" ? i + 2 + width : null;
      }
      return null;
    }
  }
}

function lex(lang: Language, source: string): Lexed {
  if (lang === 'ts' || lang === 'js') {
    const comments: [number, number][] = [];
    const withStrings = maskSource(source, true, comments);
    return { code: maskSource(source), withStrings, comments };
  }
  const code = source.split('');
  const withStrings = source.split('');
  const comments: [number, number][] = [];
  const lineComment = lang === 'python' ? '#' : '//';
  let i = 0;
  while (i < source.length) {
    if (source.startsWith(lineComment, i)) {
      const nl = source.indexOf('\n', i);
      const end = nl === -1 ? source.length : nl;
      comments.push([i, end]);
      blankInto(code, i, end);
      blankInto(withStrings, i, end);
      i = end;
      continue;
    }
    if (lang !== 'python' && source.startsWith('/*', i)) {
      // Rust block comments nest; the others end at the first `*/`.
      let depth = 1;
      let j = i + 2;
      while (j < source.length && depth > 0) {
        if (lang === 'rust' && source.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (source.startsWith('*/', j)) {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      comments.push([i, j]);
      blankInto(code, i, j);
      blankInto(withStrings, i, j);
      i = j;
      continue;
    }
    const end = stringAt(lang, source, i);
    if (end !== null) {
      blankInto(code, i, end);
      i = Math.max(end, i + 1);
      continue;
    }
    i++;
  }
  return { code: code.join(''), withStrings: withStrings.join(''), comments };
}

/** Text after a directive, up to the end of its comment. */
function tail(text: string, directiveEnd: number): string {
  return text.slice(directiveEnd).replace(/\*+\/\s*$/, '');
}

/**
 * The kind of suppression one comment carries, if any.
 *
 * Anchored at the comment's start: `@ts-ignore` only acts there, and a comment
 * that mentions a directive in passing is documentation, not a suppression.
 */
function commentKind(lang: Language, text: string): SuppressionKind | null {
  if (lang === 'ts' || lang === 'js') {
    const lead = /^(?:\/\/|\/\*+)\s*/.exec(text)?.[0].length ?? 0;
    const body = text.slice(lead);
    if (/^@ts-ignore\b/.test(body)) return 'ts-ignore';
    if (/^@ts-nocheck\b/.test(body)) return 'ts-nocheck';
    const expect = /^@ts-expect-error\b/.exec(body);
    // An @ts-expect-error fails once the error it hides is gone, so it cleans
    // itself up; with a reason it is a recorded decision. @ts-ignore does
    // neither, so it counts with or without one.
    if (expect) return /\w/.test(tail(body, expect[0].length)) ? null : 'ts-expect-error-no-reason';
    // A file-wide disable silences the rest of the file whatever it names.
    // ESLint reads it from block comments only.
    if (text.startsWith('/*') && /^eslint-disable(?![-\w])/.test(body))
      return 'eslint-disable-file';
    const line = /^eslint-disable-(?:next-)?line\b/.exec(body);
    if (line) {
      // `-- text` is ESLint's description syntax; what precedes it is the rule list.
      const rules = tail(body, line[0].length).split(/\s--\s|^--\s?/)[0] ?? '';
      return rules.trim() === '' ? 'eslint-disable-line-no-rule' : null;
    }
    const biome = /^biome-ignore(?:-all|-start)?\b/.exec(body);
    if (biome) {
      const reason = tail(body, biome[0].length).split(':').slice(1).join(':');
      return reason.trim() === '' ? 'biome-ignore-no-reason' : null;
    }
    return null;
  }
  if (lang === 'go') {
    // golangci-lint's machine-readable form has no space after `//`.
    // `//nolint:all` names a linter only in letter.
    return /^\/\/nolint(?::all\b|(?![\w:-]))/.test(text) ? 'nolint-bare' : null;
  }
  return null;
}

/**
 * Python comment segments: `x  # noqa: E501  # type: ignore[attr]` is the
 * idiom for two tools on one line, and flake8 honours `# noqa` anywhere in
 * the comment, so each `#` starts a segment of its own.
 */
function pythonKinds(text: string): SuppressionKind[] {
  const out: SuppressionKind[] = [];
  for (const segment of text.split(/(?=#)/)) {
    if (/^#\s*type:\s*ignore(?![\w-]|\s*\[)/.test(segment)) out.push('type-ignore-no-code');
    else if (/^#\s*noqa(?![\w-]|\s*:)/i.test(segment)) out.push('noqa-bare');
    else if (/^#\s*pylint:\s*(?:disable\s*=\s*all\b|skip-file\b)/.test(segment)) {
      out.push('pylint-disable-all');
    }
  }
  return out;
}

const CODE_MARKERS: Record<
  Language,
  {
    kind: SuppressionKind;
    /** Matched on the code view: comments and string contents blanked. */
    re: RegExp;
    /**
     * Checked against the strings-kept view at the match, for a marker whose
     * argument is a string (`@SuppressWarnings("all")`). Matching that view
     * outright would count the annotation quoted inside a text block.
     */
    argument?: RegExp;
  }[]
> = {
  ts: [
    { kind: 'as-any', re: /\bas\s+any\b/g },
    { kind: 'any-annotation', re: /:\s*any\b(?![$])/g },
    { kind: 'any-type-argument', re: /<any>/g },
  ],
  js: [],
  python: [],
  go: [],
  rust: [{ kind: 'crate-allow', re: /#!\[\s*allow\s*\(/g }],
  c: [
    {
      kind: 'pragma-disable-warning',
      re: /^[ \t]*#[ \t]*pragma[ \t]+warning[ \t]*\([ \t]*disable\b/gm,
    },
    {
      kind: 'pragma-disable-warning',
      re: /^[ \t]*#[ \t]*pragma[ \t]+(?:GCC|clang)[ \t]+diagnostic[ \t]+ignored\b/gm,
    },
  ],
  java: [
    {
      kind: 'suppress-warnings-all',
      re: /@(?:java\.lang\.)?SuppressWarnings\s*\(/g,
      argument:
        /^@(?:java\.lang\.)?SuppressWarnings\s*\(\s*(?:value\s*=\s*)?(?:"all"|\{[^}]*"all"[^}]*\})/,
    },
  ],
};

export interface SuppressionHit {
  kind: SuppressionKind;
  line: number;
}

export interface FileSuppressions {
  /** Lines with code on them: not blank, not only comment. */
  codeLines: number;
  hits: SuppressionHit[];
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1))
    starts.push(at + 1);
  return starts;
}

function lineOf(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * A generated file's suppressions are its generator's: TanStack Router writes
 * `@ts-nocheck` and an `as any` per route into routeTree.gen.ts, and the first
 * measurement of this rule reported exactly that file as this repository's
 * only outlier. Nobody can act on that finding by editing the file.
 */
const GENERATED_HEADER =
  /@generated\b|Code generated .* DO NOT EDIT|automatically generated|auto-generated|autogenerated/i;

function generated(path: string, source: string): boolean {
  return isGenerated(path) || GENERATED_HEADER.test(source.slice(0, 1200));
}

/**
 * Every suppression in one file, with the file's code-line count. Null = a
 * language this rule does not read, or a generated file.
 */
export function scanSuppressions(path: string, source: string): FileSuppressions | null {
  const lang = languageOf(path);
  if (lang === null || NOT_PRODUCT_CODE.test(path) || generated(path, source)) return null;
  const lexed = lex(lang, source);
  const starts = lineStarts(source);
  const hits: SuppressionHit[] = [];

  // A hand-written declaration file is where an untyped library gets its
  // types, and `any` there is often the honest answer for a dynamic API.
  const anyCounts = !/\.d\.[cm]?ts$/.test(path);
  for (const marker of CODE_MARKERS[lang]) {
    if (marker.kind.includes('any') && !anyCounts) continue;
    for (const m of lexed.code.matchAll(marker.re)) {
      if (marker.argument && !marker.argument.test(lexed.withStrings.slice(m.index))) continue;
      hits.push({ kind: marker.kind, line: lineOf(starts, m.index) });
    }
  }
  for (const [start, end] of lexed.comments) {
    const text = source.slice(start, end);
    const kinds = lang === 'python' ? pythonKinds(text) : [commentKind(lang, text)];
    for (const kind of kinds) if (kind) hits.push({ kind, line: lineOf(starts, start) });
  }
  hits.sort((a, b) => a.line - b.line);

  let codeLines = 0;
  for (const line of lexed.withStrings.split('\n')) if (line.trim() !== '') codeLines++;
  return { codeLines, hits };
}

function countByKind(hits: readonly SuppressionHit[]): Partial<Record<SuppressionKind, number>> {
  const counts: Partial<Record<SuppressionKind, number>> = {};
  for (const hit of hits) counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
  return counts;
}

export function formatCounts(counts: Partial<Record<SuppressionKind, number>>): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .map(([kind, n]) => `${kind} ${n}`)
    .join(', ');
}

const perKloc = (hits: number, lines: number): number => (lines === 0 ? 0 : (hits * 1000) / lines);
const round = (n: number): number => Number(n.toFixed(1));

export interface DensityFinding {
  ruleId: typeof SUPPRESSION_DENSITY_RULE_ID;
  /** null for the repository-level finding. */
  file: string | null;
  /** First suppression in the file; null for the repository. */
  line: number | null;
  perKloc: number;
  hits: number;
  codeLines: number;
  counts: Partial<Record<SuppressionKind, number>>;
  message: string;
}

export interface SuppressionDensity {
  perKloc: number;
  hits: number;
  codeLines: number;
  counts: Partial<Record<SuppressionKind, number>>;
  findings: DensityFinding[];
}

/**
 * The repository's suppression density, and the findings it earns: one for
 * the repository when it is over the ceiling, and one per OUTLIER file.
 */
export function suppressionDensity(
  sources: readonly { path: string; source: string }[],
  ceiling = SUPPRESSION_CEILING_PER_KLOC,
): SuppressionDensity {
  const files: { path: string; scan: FileSuppressions }[] = [];
  for (const file of sources) {
    const scan = scanSuppressions(file.path, file.source);
    if (scan) files.push({ path: file.path, scan });
  }
  const allHits = files.flatMap((f) => f.scan.hits);
  const codeLines = files.reduce((sum, f) => sum + f.scan.codeLines, 0);
  const density = perKloc(allHits.length, codeLines);
  const counts = countByKind(allHits);
  const findings: DensityFinding[] = [];

  if (allHits.length >= MIN_SUPPRESSION_HITS && density > ceiling) {
    findings.push({
      ruleId: SUPPRESSION_DENSITY_RULE_ID,
      file: null,
      line: null,
      perKloc: round(density),
      hits: allHits.length,
      codeLines,
      counts,
      message:
        `${allHits.length} checker suppressions in ${codeLines} lines of code: ${round(density)} per ` +
        `thousand, over the ceiling of ${ceiling} (${formatCounts(counts)}). Each one is a place the ` +
        'type checker or linter was told to stop looking; at this rate the checks pass because they ' +
        'were silenced, not because the code satisfies them.',
    });
  }

  const fileCeiling = Math.max(ceiling, density * FILE_OUTLIER_FACTOR);
  for (const { path, scan } of files) {
    const fileDensity = perKloc(scan.hits.length, scan.codeLines);
    if (scan.hits.length < MIN_SUPPRESSION_HITS || fileDensity <= fileCeiling) continue;
    const fileCounts = countByKind(scan.hits);
    findings.push({
      ruleId: SUPPRESSION_DENSITY_RULE_ID,
      file: path,
      line: scan.hits[0]?.line ?? 1,
      perKloc: round(fileDensity),
      hits: scan.hits.length,
      codeLines: scan.codeLines,
      counts: fileCounts,
      message:
        `${scan.hits.length} checker suppressions in ${scan.codeLines} lines of code ` +
        `(${round(fileDensity)} per thousand, against ${round(density)} for the repository): ` +
        `${formatCounts(fileCounts)}. A file this far above the rest is usually one where errors ` +
        'were silenced to get it compiling rather than fixed.',
    });
  }
  return { perKloc: round(density), hits: allHits.length, codeLines, counts, findings };
}

/**
 * Suppressions a pull request ADDS, and its added code lines.
 *
 * Each hunk is lexed on its own, from its new-side text (context plus added
 * lines), and only hits on added lines count. A hunk that opens inside a block
 * comment or a multi-line string is lexed without that context — the cost is
 * a missed or misread marker in that hunk, never one invented elsewhere.
 */
export function suppressionsInDiff(files: readonly { path: string; patch: string | null }[]): {
  codeLines: number;
  hits: (SuppressionHit & { file: string })[];
} {
  let codeLines = 0;
  const hits: (SuppressionHit & { file: string })[] = [];
  for (const file of files) {
    if (!file.patch || languageOf(file.path) === null) continue;
    if (NOT_PRODUCT_CODE.test(file.path) || isGenerated(file.path)) continue;
    const hunks: { start: number; lines: string[]; added: Set<number> }[] = [];
    for (const raw of file.patch.split('\n')) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (header) {
        hunks.push({ start: Number(header[1]), lines: [], added: new Set() });
        continue;
      }
      const hunk = hunks[hunks.length - 1];
      if (!hunk || raw.startsWith('-') || raw.startsWith('\\')) continue;
      if (raw.startsWith('+')) hunk.added.add(hunk.lines.length + 1);
      hunk.lines.push(raw.slice(1));
    }
    for (const hunk of hunks) {
      const text = hunk.lines.join('\n');
      const scan = scanSuppressions(file.path, text);
      if (!scan) continue;
      for (const hit of scan.hits) {
        if (hunk.added.has(hit.line)) {
          hits.push({ kind: hit.kind, line: hunk.start + hit.line - 1, file: file.path });
        }
      }
      const lexedLines = lex(languageOf(file.path) as Language, text).withStrings.split('\n');
      for (const n of hunk.added) if ((lexedLines[n - 1] ?? '').trim() !== '') codeLines++;
    }
  }
  return { codeLines, hits };
}

/** The pull-request finding: added code over the ceiling, with enough hits to mean it. */
export function prSuppressionFinding(
  files: readonly { path: string; patch: string | null }[],
  ceiling = SUPPRESSION_CEILING_PER_KLOC,
): (DensityFinding & { firstFile: string | null }) | null {
  const { codeLines, hits } = suppressionsInDiff(files);
  const density = perKloc(hits.length, codeLines);
  if (hits.length < MIN_PR_SUPPRESSION_HITS || density <= ceiling) return null;
  const counts = countByKind(hits);
  return {
    ruleId: SUPPRESSION_DENSITY_RULE_ID,
    file: null,
    line: null,
    firstFile: hits[0]?.file ?? null,
    perKloc: round(density),
    hits: hits.length,
    codeLines,
    counts,
    message:
      `This change adds ${hits.length} checker suppressions in ${codeLines} added lines of code ` +
      `(${round(density)} per thousand, ceiling ${ceiling}): ${formatCounts(counts)}. First at ` +
      `${hits[0]?.file}:${hits[0]?.line}. New suppressions are cheapest to remove before they merge.`,
  };
}
