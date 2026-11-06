// Unified-diff parser for the diff view (W18-30). Pure and total: any input
// yields a (possibly empty) result, because the patch text comes from a model.

export type DiffLineType = 'ctx' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
}

/** A split row: the old side and the new side of one visual line. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(p: string): string {
  const t = p.replace(/\t.*$/, '').trim();
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let o = 0;
  let n = 0;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('--- ') && !hunk) {
      file = { oldPath: stripPrefix(raw.slice(4)), newPath: '', hunks: [] };
      files.push(file);
      continue;
    }
    if (raw.startsWith('+++ ') && file && !hunk) {
      file.newPath = stripPrefix(raw.slice(4));
      continue;
    }
    const h = HUNK.exec(raw);
    if (h) {
      if (!file) {
        file = { oldPath: '', newPath: '', hunks: [] };
        files.push(file);
      }
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      o = Number(h[1]);
      n = Number(h[2]);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('+')) hunk.lines.push({ type: 'add', oldNo: null, newNo: n++, text: raw.slice(1) });
    else if (raw.startsWith('-')) hunk.lines.push({ type: 'del', oldNo: o++, newNo: null, text: raw.slice(1) });
    else if (raw.startsWith(' ')) hunk.lines.push({ type: 'ctx', oldNo: o++, newNo: n++, text: raw.slice(1) });
    else if (raw === '') continue;
    else if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    else hunk = null; // a new file header or noise ends the hunk
  }
  return files.filter((f) => f.hunks.length > 0);
}

/** Pair runs of removed lines with the added lines that follow them. */
export function toSplitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.type === 'ctx') {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === 'del') dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.type === 'add') adds.push(lines[i++]!);
    const len = Math.max(dels.length, adds.length);
    for (let k = 0; k < len; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

export function diffStat(files: readonly DiffFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files)
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.type === 'add') added++;
        else if (l.type === 'del') removed++;
      }
  return { added, removed };
}

/**
 * Runs of removed lines followed by added lines, paired in order: the old and
 * new copy of the same line, as far as a diff can tell (W26-02).
 */
function pairedChanges(lines: readonly DiffLine[]): [DiffLine, DiffLine][] {
  const pairs: [DiffLine, DiffLine][] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.type !== 'del') {
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === 'del') dels.push(lines[i++]!);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.type === 'add') adds.push(lines[i++]!);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) pairs.push([dels[k]!, adds[k]!]);
  }
  return pairs;
}

/**
 * The part of each paired line that changed: the characters between the
 * common prefix and the common suffix, as [start, end) on that line (W26-02).
 * A line with nothing in common gets no span, since marking all of it says
 * nothing the red or green row does not already say.
 */
export function changedSpans(lines: readonly DiffLine[]): Map<DiffLine, [number, number]> {
  const out = new Map<DiffLine, [number, number]>();
  for (const [del, add] of pairedChanges(lines)) {
    const a = del.text;
    const b = add.text;
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (
      suf < a.length - pre &&
      suf < b.length - pre &&
      a[a.length - 1 - suf] === b[b.length - 1 - suf]
    )
      suf++;
    if (pre === 0 && suf === 0) continue;
    if (a.length - suf > pre) out.set(del, [pre, a.length - suf]);
    if (b.length - suf > pre) out.set(add, [pre, b.length - suf]);
  }
  return out;
}

/**
 * Hide whitespace (W26-02): a removed and added pair that differ only in
 * whitespace is shown once, as an unchanged line with the new text.
 */
export function hideWhitespaceOnly(lines: readonly DiffLine[]): DiffLine[] {
  const same = new Map<DiffLine, DiffLine>();
  const drop = new Set<DiffLine>();
  for (const [del, add] of pairedChanges(lines)) {
    if (del.text.replace(/\s+/g, '') === add.text.replace(/\s+/g, '')) {
      drop.add(del);
      same.set(add, { type: 'ctx', oldNo: del.oldNo, newNo: add.newNo, text: add.text });
    }
  }
  if (drop.size === 0) return [...lines];
  return lines.filter((l) => !drop.has(l)).map((l) => same.get(l) ?? l);
}
