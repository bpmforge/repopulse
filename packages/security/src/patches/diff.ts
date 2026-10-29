// Unified-diff handling for verified patches (W18-19, D16 "Verified + CI pull").
//
// The model's diff is UNTRUSTED INPUT. It was produced by reading a customer's
// file — which may itself contain text written to steer a model — so nothing
// here assumes the diff is well-formed, touches the file it claims to, or is
// the size it says. Everything below either proves a property or refuses.
//
// What a diff may do is deliberately narrow: modify ONE existing file, the
// file the finding is in. Creating, deleting or renaming files, touching a
// second file, or changing binary content are all refused — not because they
// are never the right fix, but because the verifier re-scans one file and
// cannot vouch for a change it did not scan.

/** Hard cap on the diff text. A fix that needs more than this is a refactor. */
export const MAX_DIFF_BYTES = 16 * 1024;
/** Hard cap on changed (+/-) lines, for the same reason. */
export const MAX_CHANGED_LINES = 200;

export interface DiffLine {
  kind: ' ' | '-' | '+';
  text: string;
}

export interface Hunk {
  /** 1-based start line in the original file, as the header states it. */
  oldStart: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

export class PatchRejectedError extends Error {
  constructor(
    readonly code:
      | 'empty'
      | 'too_large'
      | 'malformed'
      | 'wrong_file'
      | 'multiple_files'
      | 'file_mode'
      | 'does_not_apply'
      | 'no_change',
    message: string,
  ) {
    super(message);
    this.name = 'PatchRejectedError';
  }
}

/**
 * Pulls the diff out of what the model returned.
 *
 * The prompt asks for `{"diff": "..."}`; local models sometimes answer with a
 * fenced block or a bare diff instead. All three are accepted because the shape
 * of the wrapper says nothing about the quality of the fix — the parser and the
 * re-scan are what judge that.
 */
export function extractDiff(modelText: string): string {
  const trimmed = modelText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && 'diff' in parsed) {
        const diff = (parsed as { diff: unknown }).diff;
        if (typeof diff === 'string') return diff;
      }
    } catch {
      // Fall through: not JSON after all.
    }
  }
  const fenced = /```(?:diff|patch)?[^\n]*\n([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1];
  return trimmed;
}

function stripPrefix(raw: string): string {
  // Timestamps after a tab are legal in unified diffs; the path is before it.
  const path = raw.split('\t')[0]!.trim();
  return path.replace(/^[ab]\//, '');
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a single-file unified diff.
 *
 * Hunk header COUNTS are not trusted: models routinely miscount, and a header
 * that disagrees with its own body is a clerical error, not a semantic one. The
 * body is authoritative and the canonical diff produced after applying carries
 * correct counts. Start lines are kept only as a hint for where to look.
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  if (text.trim() === '') throw new PatchRejectedError('empty', 'The model returned no diff.');
  if (Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES) {
    throw new PatchRejectedError(
      'too_large',
      `The diff is larger than ${MAX_DIFF_BYTES} bytes; a verified patch is a targeted fix, not a rewrite.`,
    );
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // Trailing blank lines are an artefact of how the text was wrapped, not
  // context lines; a blank context line inside a hunk is still handled below.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let oldPath: string | null = null;
  let newPath: string | null = null;
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || line.startsWith('index ')) continue;
    if (
      /^(new|deleted) file mode /.test(line) ||
      /^(old|new) mode /.test(line) ||
      line.startsWith('rename ') ||
      line.startsWith('similarity index') ||
      line.startsWith('Binary files') ||
      line.startsWith('GIT binary patch')
    ) {
      throw new PatchRejectedError(
        'file_mode',
        'The diff creates, deletes, renames or changes the mode of a file; a verified patch may only edit the file the finding is in.',
      );
    }
    // A file header is `--- ` FOLLOWED BY `+++ `. Keyed on the pair because a
    // removed line whose text starts with "-- " (an SQL or Lua comment) also
    // begins `--- `, and reading it as a header would split one hunk in two.
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      if (oldPath !== null) {
        throw new PatchRejectedError(
          'multiple_files',
          'The diff touches more than one file; a verified patch may only edit the file the finding is in.',
        );
      }
      oldPath = stripPrefix(line.slice(4));
      newPath = stripPrefix(lines[i + 1]!.slice(4));
      current = null;
      i += 1;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      if (oldPath === null || newPath === null) {
        throw new PatchRejectedError('malformed', 'A hunk appears before the file header.');
      }
      current = { oldStart: Number(header[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      throw new PatchRejectedError(
        'malformed',
        `Unexpected line outside a hunk: ${line.slice(0, 80)}`,
      );
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const kind = line[0];
    if (line === '') {
      // A context line whose single leading space was trimmed by whatever
      // carried the text. Treated as the blank line it almost always is; if it
      // was not, the content match in applyPatch refuses the hunk.
      current.lines.push({ kind: ' ', text: '' });
    } else if (kind === ' ' || kind === '-' || kind === '+') {
      current.lines.push({ kind, text: line.slice(1) });
    } else {
      throw new PatchRejectedError('malformed', `Unrecognised diff line: ${line.slice(0, 80)}`);
    }
  }

  if (oldPath === null || newPath === null) {
    throw new PatchRejectedError('malformed', 'The diff has no ---/+++ file header.');
  }
  if (oldPath === '/dev/null' || newPath === '/dev/null') {
    throw new PatchRejectedError(
      'file_mode',
      'The diff creates or deletes a file; a verified patch may only edit the file the finding is in.',
    );
  }
  if (oldPath !== newPath) {
    throw new PatchRejectedError('file_mode', 'The diff renames a file.');
  }
  if (hunks.length === 0 || hunks.every((h) => h.lines.every((l) => l.kind === ' '))) {
    throw new PatchRejectedError('no_change', 'The diff contains no changes.');
  }
  const changed = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind !== ' ').length, 0);
  if (changed > MAX_CHANGED_LINES) {
    throw new PatchRejectedError(
      'too_large',
      `The diff changes ${changed} lines (cap ${MAX_CHANGED_LINES}); a verified patch is a targeted fix, not a rewrite.`,
    );
  }

  return { oldPath, newPath, hunks };
}

/**
 * Checks the diff is for the finding's file and nothing else.
 *
 * Path comparison is exact after the a/ b/ prefix is removed. A diff that names
 * `./src/x.ts` or `src//x.ts` for `src/x.ts` is refused rather than normalised:
 * a path that has to be interpreted is a path that can be made to mean another
 * file.
 */
export function assertTargetsFile(parsed: ParsedDiff, file: string): void {
  if (parsed.oldPath !== file) {
    throw new PatchRejectedError(
      'wrong_file',
      `The diff edits ${parsed.oldPath}, but the finding is in ${file}.`,
    );
  }
}

function splitSource(source: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = source.endsWith('\n');
  const body = trailingNewline ? source.slice(0, -1) : source;
  return { lines: body === '' ? [] : body.split('\n'), trailingNewline };
}

function matchesAt(
  lines: readonly string[],
  at: number,
  expected: readonly string[],
  same: (a: string, b: string) => boolean,
): boolean {
  if (at < 0 || at + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (!same(lines[at + i]!, expected[i]!)) return false;
  }
  return true;
}

const exact = (a: string, b: string): boolean => a === b;
/**
 * Equal apart from leading and trailing whitespace. Whitespace INSIDE a line is
 * still compared exactly, and nothing else is forgiven: this tolerates a model
 * that copied a line from the gutter with a space of indentation too many or
 * too few, or with trailing blanks — not one that paraphrased the code.
 */
const sameIgnoringEdgeWhitespace = (a: string, b: string): boolean => a.trim() === b.trim();

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

type Reindent = { add: string } | { remove: string } | null;

/**
 * How the hunk's indentation differs from the file's, when it differs the same
 * way on every non-blank old line (e.g. the model dropped one space from each).
 * Null when there is no difference or it is inconsistent: added lines are then
 * left as the model wrote them and the re-scan judges the result.
 */
function consistentReindent(fileLines: readonly string[], hunkLines: readonly string[]): Reindent {
  let found: Reindent | undefined;
  for (let i = 0; i < hunkLines.length; i++) {
    if (hunkLines[i]!.trim() === '') continue;
    const fw = leadingWhitespace(fileLines[i]!);
    const hw = leadingWhitespace(hunkLines[i]!);
    let here: Reindent;
    if (fw.startsWith(hw)) here = { add: fw.slice(hw.length) };
    else if (hw.startsWith(fw)) here = { remove: hw.slice(fw.length) };
    else return null;
    if (found === undefined) found = here;
    else if (JSON.stringify(found) !== JSON.stringify(here)) return null;
  }
  if (!found) return null;
  return ('add' in found ? found.add : found.remove) === '' ? null : found;
}

function reindent(line: string, how: Reindent): string {
  if (how === null || line.trim() === '') return line;
  if ('add' in how) return how.add + line;
  return line.startsWith(how.remove) ? line.slice(how.remove.length) : line;
}

export interface AppliedPatch {
  /** The patched file content. */
  after: string;
  /**
   * The diff re-rendered from what was actually applied: real line numbers,
   * correct counts, `a/` `b/` paths, and context/removed lines exactly as the
   * file has them. This — not the model's text — is what is stored and handed
   * to the developer, so `git apply` takes it as-is.
   */
  canonicalDiff: string;
  /** True when any hunk was applied at a different line than its header named. */
  reanchored: boolean;
  /** True when any hunk matched only after ignoring edge whitespace. */
  whitespaceTolerant: boolean;
  /** One short sentence per adjustment, recorded on the patch row's reason. */
  notes: string[];
}

/**
 * Where a hunk's old text (context + removed lines) sits, under a line
 * comparison: searched from `cursor` (after the previous hunk), with the
 * header's start line used only to choose between several matches.
 * -1 when it matches nowhere; throws when two matches are equally near.
 */
function locate(
  lines: readonly string[],
  cursor: number,
  oldBlock: readonly string[],
  hint: number,
  oldStart: number,
  same: (a: string, b: string) => boolean,
): number {
  const candidates: number[] = [];
  for (let i = cursor; i + oldBlock.length <= lines.length; i++) {
    if (matchesAt(lines, i, oldBlock, same)) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  candidates.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
  const best = candidates[0]!;
  const tie = candidates[1];
  if (tie !== undefined && Math.abs(tie - hint) === Math.abs(best - hint)) {
    throw new PatchRejectedError(
      'does_not_apply',
      `A hunk near line ${oldStart} matches more than one place in the file.`,
    );
  }
  return best;
}

/**
 * Applies a parsed diff to the file's content, anchoring each hunk by CONTENT.
 *
 * Local models get hunk headers wrong far more often than content, so neither
 * the header's line numbers nor its counts are trusted. Each hunk's old text
 * (context + removed lines) is searched for in the region after the previous
 * hunk — exact match first; only when it appears nowhere exactly, again with
 * each line compared ignoring leading/trailing whitespace (indentation copied
 * off by a space, trailing blanks). Nothing beyond edge whitespace is forgiven.
 * Between several matches the one nearest the header's line wins; an
 * ambiguous hunk (two matches at equal distance) is refused rather than
 * guessed: applying a fix to the wrong copy of a repeated block is how a patch
 * "clears" a finding by editing something else.
 *
 * A whitespace-tolerant match keeps the file's own text for context and
 * removed lines, and shifts added lines by the hunk's indentation offset when
 * that offset is the same on every line.
 */
export function applyPatch(source: string, parsed: ParsedDiff): AppliedPatch {
  const { lines, trailingNewline } = splitSource(source);
  const out: string[] = [];
  const rendered: string[] = [`--- a/${parsed.oldPath}`, `+++ b/${parsed.newPath}`];
  const notes: string[] = [];
  let reanchored = false;
  let whitespaceTolerant = false;
  let cursor = 0; // next unconsumed index in `lines`
  let delta = 0; // new-file line offset accumulated by earlier hunks

  for (const [index, hunk] of parsed.hunks.entries()) {
    const oldBlock = hunk.lines.filter((l) => l.kind !== '+').map((l) => l.text);
    const hint = Math.max(0, hunk.oldStart - 1);
    const label = parsed.hunks.length > 1 ? `Hunk ${index + 1}` : 'The hunk';

    let at = -1;
    let tolerant = false;
    if (oldBlock.length === 0) {
      // Pure insertion with no context: only the stated position is honest.
      at = Math.min(Math.max(hint, cursor), lines.length);
    } else {
      at = locate(lines, cursor, oldBlock, hint, hunk.oldStart, exact);
      // The tolerant pass needs a non-blank line to anchor on: an all-blank
      // block would match any run of whitespace-only lines.
      if (at < 0 && oldBlock.some((l) => l.trim() !== '')) {
        at = locate(lines, cursor, oldBlock, hint, hunk.oldStart, sameIgnoringEdgeWhitespace);
        tolerant = at >= 0;
      }
    }
    if (at < 0) {
      throw new PatchRejectedError(
        'does_not_apply',
        `A hunk near line ${hunk.oldStart} does not match the file at the scanned commit.`,
      );
    }

    // Context and removed lines are the file's own text; added lines are the
    // model's, shifted by the hunk's consistent indentation offset if any.
    const how = tolerant
      ? consistentReindent(lines.slice(at, at + oldBlock.length), oldBlock)
      : null;
    const body: DiffLine[] = [];
    let k = at;
    for (const l of hunk.lines) {
      if (l.kind === '+') body.push({ kind: '+', text: reindent(l.text, how) });
      else body.push({ kind: l.kind, text: lines[k++]! });
    }

    // Loops, not push(...slice): one argument per line throws RangeError
    // (call stack) at about 125k lines, and generated files get that long.
    for (let i = cursor; i < at; i++) out.push(lines[i]!);
    const newBlock = body.filter((l) => l.kind !== '-').map((l) => l.text);
    for (const line of newBlock) out.push(line);

    const oldStartLine = oldBlock.length === 0 ? at : at + 1;
    const newStartLine = newBlock.length === 0 ? at + delta : at + delta + 1;
    rendered.push(
      `@@ -${oldStartLine},${oldBlock.length} +${newStartLine},${newBlock.length} @@`,
      ...body.map((l) => `${l.kind}${l.text}`),
    );

    if (oldBlock.length > 0 && oldStartLine !== hunk.oldStart) {
      reanchored = true;
      notes.push(
        `${label}'s header named line ${hunk.oldStart}; it was applied at line ${oldStartLine}, where its context matched.`,
      );
    }
    if (tolerant) {
      whitespaceTolerant = true;
      notes.push(
        `${label} matched the file only when leading/trailing whitespace was ignored${how ? '; its added lines were re-indented to match' : ''}.`,
      );
    }

    cursor = at + oldBlock.length;
    delta += newBlock.length - oldBlock.length;
  }
  for (let i = cursor; i < lines.length; i++) out.push(lines[i]!);

  const after = out.length === 0 ? '' : out.join('\n') + (trailingNewline ? '\n' : '');
  if (after === source) {
    throw new PatchRejectedError('no_change', 'The diff leaves the file unchanged.');
  }
  return {
    after,
    canonicalDiff: rendered.join('\n') + '\n',
    reanchored,
    whitespaceTolerant,
    notes,
  };
}

/** Parse, check the target, apply — the whole shape gate in one call. */
export function validateAndApply(args: {
  modelText: string;
  file: string;
  source: string;
}): AppliedPatch {
  const parsed = parseUnifiedDiff(extractDiff(args.modelText));
  assertTargetsFile(parsed, args.file);
  return applyPatch(args.source, parsed);
}
