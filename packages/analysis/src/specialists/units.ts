import type { DiffFile } from '../chunker/index.js';
import { isGenerated } from '../chunker/index.js';
import type { SpecialistId } from './registry.js';

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
  | { kind: 'module'; name: string; files: readonly ModuleFile[] };

/**
 * W27-08: per area, the line ranges of a file that area reads (1-based,
 * inclusive), cut from the code map's function spans and the scanners'
 * measurements. An area with no entry reads the whole file; an EMPTY list
 * means the file has nothing for that area and is not sent to it.
 */
export type AreaFocus = Partial<Record<SpecialistId, readonly (readonly [number, number])[]>>;

export interface ModuleFile {
  path: string;
  content: string;
  focus?: AreaFocus;
}

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

/**
 * W27-08: only `ranges` of a file, as add-only hunks that keep the file's real
 * line numbers (so a quote and its line range still validate). Ranges are
 * clipped, sorted and merged; a gap of 3 lines or fewer is bridged rather than
 * cut. Long ranges are windowed like a whole file.
 */
export function rangesAsPatch(
  content: string,
  ranges: readonly (readonly [number, number])[],
  windowLines = WINDOW_LINES,
): string {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const clipped = ranges
    .map(([a, b]) => [Math.max(1, Math.min(a, b)), Math.min(lines.length, Math.max(a, b))] as const)
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of clipped) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 4) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const hunks: string[] = [];
  for (const [a, b] of merged) {
    for (let start = a; start <= b; start += windowLines) {
      const slice = lines.slice(start - 1, Math.min(b, start + windowLines - 1));
      hunks.push(`@@ -0,0 +${start},${slice.length} @@\n${slice.map((l) => `+${l}`).join('\n')}`);
    }
  }
  return hunks.join('\n');
}

/**
 * W27-08: the input as `id` reads it. A module file with a focus for `id` is
 * cut to those ranges, or left out (null) when the list is empty; every other
 * file is whole.
 */
export function toDiffFilesFor(input: ReviewInput, id: SpecialistId): DiffFile[] {
  if (input.kind !== 'module') return toDiffFiles(input);
  const out: DiffFile[] = [];
  for (const f of input.files) {
    const ranges = f.focus?.[id];
    if (ranges === undefined) out.push(fileToDiff(f.path, f.content));
    else if (ranges.length > 0) out.push(focusedToDiff(f.path, f.content, ranges));
  }
  return out;
}

/**
 * W27-08/W27-09: the input for one combined review: per file, the union of the
 * ranges its focused areas read. Areas without a focus of their own (best
 * practices, test coverage, AI slop) read what is sent rather than widening it
 * to the whole file: measured on gin, the union with three whole-file areas
 * was always the whole file, so the focus never narrowed a combined call.
 * A file a focusing area has no focus for (security, performance or code
 * health: the code map does not cover it, or nothing was measured) is sent
 * whole; a file whose focus holds no range for any of its areas is not sent.
 */
/** Areas the focus builder cuts down; the others read whatever is sent. */
const FOCUSING_AREAS: ReadonlySet<SpecialistId> = new Set([
  'security',
  'performance',
  'code_health',
]);

export function toCombinedDiffFiles(
  input: ReviewInput,
  areasFor: (path: string) => ReadonlySet<SpecialistId>,
): { files: DiffFile[]; reads: Map<string, Set<SpecialistId>> } {
  const reads = new Map<string, Set<SpecialistId>>();
  if (input.kind !== 'module') {
    const files = toDiffFiles(input);
    for (const f of files) reads.set(f.path, new Set(areasFor(f.path)));
    return { files, reads };
  }
  const files: DiffFile[] = [];
  for (const f of input.files) {
    const areas = [...areasFor(f.path)];
    // A focusing area with no focus for this file reads it whole (the code map
    // does not cover it, or nothing was measured): the file goes whole.
    const whole = areas.some((id) => FOCUSING_AREAS.has(id) && f.focus?.[id] === undefined);
    const ranges = areas.flatMap((id) => f.focus?.[id] ?? []);
    const reading =
      whole || ranges.length > 0
        ? areas.filter((id) => f.focus?.[id] === undefined || f.focus[id]!.length > 0)
        : [];
    reads.set(f.path, new Set(reading));
    if (reading.length === 0) continue;
    files.push(whole ? fileToDiff(f.path, f.content) : focusedToDiff(f.path, f.content, ranges));
  }
  return { files, reads };
}

function focusedToDiff(
  path: string,
  content: string,
  ranges: readonly (readonly [number, number])[],
): DiffFile {
  if (content.includes('\u0000')) return { path, patch: null, binary: true };
  if (isGenerated(path)) return { path, patch: content };
  return { path, patch: rangesAsPatch(content, ranges) };
}

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
  if (content.includes('\u0000')) return { path, patch: null, binary: true };
  // Generated files are skipped by the chunker with a reason; hand them over
  // unchanged so that reason is recorded rather than the file vanishing here.
  if (isGenerated(path)) return { path, patch: content };
  return { path, patch: contentAsPatch(content) };
}
