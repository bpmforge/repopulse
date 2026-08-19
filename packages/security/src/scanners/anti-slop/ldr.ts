// Logic density ratio (W9-03, CODE_HEALTH_SUITE.md §1, FR-CH-3).
//
// LDR = logic / (logic + overhead), where overhead is imports, type-only
// declarations, comments, docstrings and blank lines. Below 0.3 the file is
// mostly scaffolding around very little behaviour — the shape a generator
// produces when it is asked for a module and has nothing to put in it.
//
// WHAT THIS MEASURE IS NOT. A low LDR is not a defect; it is a SIGNAL, and a
// deliberately-documented module will trip it. That is why the finding says
// which lines it counted as overhead: a reader who disagrees can see the
// arithmetic rather than argue with a number. This very file would score
// poorly, and that is the correct answer for a file whose comments carry the
// reasoning.

export interface LineBreakdown {
  logic: number;
  overhead: number;
  /** Blank lines, counted as overhead but reported separately. */
  blank: number;
  comment: number;
  imports: number;
  typeOnly: number;
}

export interface LdrResult extends LineBreakdown {
  /** null when the file has no countable lines at all. */
  ratio: number | null;
  totalLines: number;
}

const IMPORT =
  /^\s*(import\s|export\s+\*\s+from|export\s+\{[^}]*\}\s+from|const\s+\w+\s*=\s*require\()/;
const TYPE_ONLY = /^\s*(export\s+)?(type|interface)\s+\w/;
const CLOSING_ONLY = /^\s*[)}\];,]+\s*;?\s*$/;

/**
 * Counts a file's lines.
 *
 * Block comments are tracked with a state flag rather than a regex over the
 * whole file: a `/*` inside a string would otherwise swallow the rest of the
 * file as comment and hand back an LDR of nearly zero — which is exactly the
 * kind of wrong that looks like a finding.
 */
export function countLines(source: string): LineBreakdown & { totalLines: number } {
  const counts: LineBreakdown & { totalLines: number } = {
    logic: 0,
    overhead: 0,
    blank: 0,
    comment: 0,
    imports: 0,
    typeOnly: 0,
    totalLines: 0,
  };

  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    counts.totalLines += 1;
    const line = raw.trim();

    if (inBlockComment) {
      counts.comment += 1;
      counts.overhead += 1;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line === '') {
      counts.blank += 1;
      counts.overhead += 1;
      continue;
    }
    if (line.startsWith('/*')) {
      counts.comment += 1;
      counts.overhead += 1;
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) {
      counts.comment += 1;
      counts.overhead += 1;
      continue;
    }
    if (IMPORT.test(line)) {
      counts.imports += 1;
      counts.overhead += 1;
      continue;
    }
    if (TYPE_ONLY.test(line)) {
      counts.typeOnly += 1;
      counts.overhead += 1;
      continue;
    }
    // A line that is only a closing brace is neither logic nor overhead in any
    // interesting sense. It is counted as logic because excluding it would
    // make deeply-nested code look denser than flat code, which is backwards.
    if (CLOSING_ONLY.test(line)) {
      counts.logic += 1;
      continue;
    }
    counts.logic += 1;
  }

  return counts;
}

export function computeLdr(source: string): LdrResult {
  const counts = countLines(source);
  const denominator = counts.logic + counts.overhead;
  // A file of nothing but blank lines has no ratio. Counting blanks in the
  // denominator would make an empty file score 0 — maximally sloppy — which is
  // the opposite of true and the first thing anyone would notice.
  const meaningful = denominator - counts.blank;
  return {
    ...counts,
    // null, not 0: a ratio over nothing is not a low ratio.
    ratio: denominator === 0 || meaningful === 0 ? null : counts.logic / denominator,
  };
}

export const LDR_FLOOR = 0.3;

export interface LdrFinding {
  ruleId: 'slop.low_logic_density';
  file: string;
  ratio: number;
  breakdown: LineBreakdown;
  message: string;
}

/** Files whose LDR is BELOW the floor. At the floor is not below it. */
export function ldrFindings(
  files: readonly { path: string; source: string }[],
  floor = LDR_FLOOR,
): LdrFinding[] {
  const out: LdrFinding[] = [];
  for (const file of files) {
    const ldr = computeLdr(file.source);
    if (ldr.ratio === null || ldr.ratio >= floor) continue;
    out.push({
      ruleId: 'slop.low_logic_density',
      file: file.path,
      ratio: Number(ldr.ratio.toFixed(3)),
      breakdown: {
        logic: ldr.logic,
        overhead: ldr.overhead,
        blank: ldr.blank,
        comment: ldr.comment,
        imports: ldr.imports,
        typeOnly: ldr.typeOnly,
      },
      message:
        `Logic density ${ldr.ratio.toFixed(2)} is below ${floor}: ${ldr.logic} lines of logic ` +
        `against ${ldr.overhead} of overhead (${ldr.comment} comment, ${ldr.imports} import, ` +
        `${ldr.blank} blank, ${ldr.typeOnly} type-only). A deliberately documented module will ` +
        'score low too — the counts are here so the arithmetic can be argued with rather than the number.',
    });
  }
  return out;
}

export interface DocInflation {
  ruleId: 'slop.docstring_inflation';
  file: string;
  symbol: string;
  docLines: number;
  implLines: number;
  ratio: number;
  message: string;
}

export const DOC_IMPL_RATIO = 3;

/**
 * Exported symbols whose doc comment is more than 3x their implementation.
 *
 * Per SYMBOL, not per file, because the failure has a shape: a twelve-line
 * JSDoc block above a three-line delegating wrapper. A file-level measure
 * averages that away against the one function that does the work.
 */
export function docstringInflation(
  file: string,
  source: string,
  ratioLimit = DOC_IMPL_RATIO,
): DocInflation[] {
  const lines = source.split('\n');
  const out: DocInflation[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.trim().startsWith('/**')) continue;
    let end = i;
    while (end < lines.length && !lines[end]?.includes('*/')) end++;
    const docLines = end - i + 1;

    // The first exported declaration after the block. A doc comment that
    // documents nothing (the next line is another comment, or the file ends)
    // is not inflation — it is a header, and this rule must not fire on one.
    let declIndex = end + 1;
    while (declIndex < lines.length && lines[declIndex]?.trim() === '') declIndex++;
    const decl = lines[declIndex]?.trim() ?? '';
    if (!/^export\s+(async\s+)?(function|const|class)\s+(\w+)/.test(decl)) {
      i = end;
      continue;
    }
    const symbol = /^export\s+(async\s+)?(function|const|class)\s+(\w+)/.exec(decl)?.[3] ?? '?';

    // Implementation length: to the next export or the end of file, counting
    // only non-blank, non-comment lines.
    let implLines = 0;
    for (let j = declIndex; j < lines.length; j++) {
      const line = lines[j]?.trim() ?? '';
      if (j > declIndex && (line.startsWith('/**') || /^export\s/.test(line))) break;
      if (line === '' || line.startsWith('//') || line.startsWith('*')) continue;
      implLines += 1;
    }

    const ratio = implLines === 0 ? Number.POSITIVE_INFINITY : docLines / implLines;
    if (ratio > ratioLimit) {
      out.push({
        ruleId: 'slop.docstring_inflation',
        file,
        symbol,
        docLines,
        implLines,
        ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : ratioLimit + 1,
        message:
          `${symbol}: ${docLines} lines of documentation over ${implLines} of implementation. ` +
          'Documentation that restates a short function goes stale faster than it helps — the ' +
          'ones worth keeping explain a constraint the code cannot.',
      });
    }
    i = end;
  }

  return out;
}
