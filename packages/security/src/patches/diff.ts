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
      // was not, the strict content match in applyPatch refuses the hunk.
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

function matchesAt(lines: readonly string[], at: number, expected: readonly string[]): boolean {
  if (at < 0 || at + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (lines[at + i] !== expected[i]) return false;
  }
  return true;
}

export interface AppliedPatch {
  /** The patched file content. */
  after: string;
  /**
   * The diff re-rendered from what was actually applied: real line numbers,
   * correct counts, `a/` `b/` paths. This — not the model's text — is what is
   * stored and handed to the developer, so `git apply` takes it as-is.
   */
  canonicalDiff: string;
}

/**
 * Applies a parsed diff to the file's content.
 *
 * Content must match EXACTLY — no whitespace fuzz, no partial context. A hunk
 * may sit at a different line than its header says (models get line numbers
 * wrong far more often than content), so each hunk is searched for, nearest
 * the stated line first, in the region after the previous hunk. An ambiguous
 * hunk (its old text appears twice at equal distance) is refused rather than
 * guessed: applying a fix to the wrong copy of a repeated block is how a patch
 * "clears" a finding by editing something else.
 */
export function applyPatch(source: string, parsed: ParsedDiff): AppliedPatch {
  const { lines, trailingNewline } = splitSource(source);
  const out: string[] = [];
  const rendered: string[] = [`--- a/${parsed.oldPath}`, `+++ b/${parsed.newPath}`];
  let cursor = 0; // next unconsumed index in `lines`
  let delta = 0; // new-file line offset accumulated by earlier hunks

  for (const hunk of parsed.hunks) {
    const oldBlock = hunk.lines.filter((l) => l.kind !== '+').map((l) => l.text);
    const hint = Math.max(0, hunk.oldStart - 1);

    let at = -1;
    if (oldBlock.length === 0) {
      // Pure insertion with no context: only the stated position is honest.
      at = Math.min(Math.max(hint, cursor), lines.length);
    } else {
      const candidates: number[] = [];
      for (let i = cursor; i + oldBlock.length <= lines.length; i++) {
        if (matchesAt(lines, i, oldBlock)) candidates.push(i);
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => Math.abs(a - hint) - Math.abs(b - hint));
        const best = candidates[0]!;
        const tie = candidates[1];
        if (tie !== undefined && Math.abs(tie - hint) === Math.abs(best - hint)) {
          throw new PatchRejectedError(
            'does_not_apply',
            `A hunk near line ${hunk.oldStart} matches more than one place in the file.`,
          );
        }
        at = best;
      }
    }
    if (at < 0) {
      throw new PatchRejectedError(
        'does_not_apply',
        `A hunk near line ${hunk.oldStart} does not match the file at the scanned commit.`,
      );
    }

    out.push(...lines.slice(cursor, at));
    const newBlock = hunk.lines.filter((l) => l.kind !== '-').map((l) => l.text);
    out.push(...newBlock);

    const oldStartLine = oldBlock.length === 0 ? at : at + 1;
    const newStartLine = newBlock.length === 0 ? at + delta : at + delta + 1;
    rendered.push(
      `@@ -${oldStartLine},${oldBlock.length} +${newStartLine},${newBlock.length} @@`,
      ...hunk.lines.map((l) => `${l.kind}${l.text}`),
    );

    cursor = at + oldBlock.length;
    delta += newBlock.length - oldBlock.length;
  }
  out.push(...lines.slice(cursor));

  const after = out.length === 0 ? '' : out.join('\n') + (trailingNewline ? '\n' : '');
  if (after === source) {
    throw new PatchRejectedError('no_change', 'The diff leaves the file unchanged.');
  }
  return { after, canonicalDiff: rendered.join('\n') + '\n' };
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
