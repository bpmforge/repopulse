import type { DiffFile } from '../chunker/index.js';
import { isGenerated } from '../chunker/index.js';

// What a specialist reviews (W19-03): a diff, one file, or a module.
//
// The chunker, the prompt builder and the evidence validator all speak "patch".
// Rather than teach each of them a second input type, a file or module is
// presented as the patch that ADDS it — every line `+`, in line-numbered
// windows. That keeps one chunker, one budget rule and one evidence check:
// a quote must still be a substring of the chunk text the model was shown.

export type ReviewInput =
  | { kind: 'diff'; files: readonly DiffFile[] }
  | { kind: 'file'; path: string; content: string }
  | { kind: 'module'; name: string; files: readonly { path: string; content: string }[] };

/** Lines per window. Small enough that a window is rarely the budget's limit. */
export const WINDOW_LINES = 120;

/** A whole file as an add-only patch, in numbered windows. */
export function contentAsPatch(content: string, windowLines = WINDOW_LINES): string {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const hunks: string[] = [];
  for (let start = 0; start < lines.length; start += windowLines) {
    const slice = lines.slice(start, start + windowLines);
    hunks.push(`@@ -0,0 +${start + 1},${slice.length} @@\n${slice.map((l) => `+${l}`).join('\n')}`);
  }
  return hunks.join('\n');
}

const BINARY_HINT = /\u0000/;

/** The input as the diff-shaped files the chunker takes. */
export function toDiffFiles(input: ReviewInput): DiffFile[] {
  switch (input.kind) {
    case 'diff':
      return [...input.files];
    case 'file':
      return [fileToDiff(input.path, input.content)];
    case 'module':
      return input.files.map((f) => fileToDiff(f.path, f.content));
  }
}

function fileToDiff(path: string, content: string): DiffFile {
  if (BINARY_HINT.test(content)) return { path, patch: null, binary: true };
  // Generated files are skipped by the chunker with a reason; hand them over
  // unchanged so that reason is recorded rather than the file vanishing here.
  if (isGenerated(path)) return { path, patch: content };
  return { path, patch: contentAsPatch(content) };
}
