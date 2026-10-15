// Unified-diff reading for the sensitive-change radar (W18-21).
//
// The radar needs BOTH sides of a change, which is why it has its own reader
// rather than reusing the secrets scanner's addedLines(): a removed
// authorisation check exists only on the `-` side, and it is the whole point.

export interface PatchLine {
  side: 'removed' | 'added';
  text: string;
  /**
   * Where this sits in the NEW file. For a removed line that is the line that
   * now occupies its place — the only location a reader of the PR can open,
   * since the removed text no longer has one.
   */
  line: number;
  /** Index of the hunk, so a removed line can be paired with its replacement. */
  hunk: number;
}

export function patchLines(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let newLine = 0;
  let hunk = -1;
  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      hunk += 1;
      continue;
    }
    if (hunk < 0) continue; // preamble before the first hunk
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+')) {
      out.push({ side: 'added', text: raw.slice(1), line: newLine, hunk });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      // A deletion at the very top of a file has no line before it; line 1 is
      // the honest nearest location rather than a line 0 nothing can open.
      out.push({ side: 'removed', text: raw.slice(1), line: Math.max(1, newLine), hunk });
      continue;
    }
    newLine += 1; // context line
  }
  return out;
}

export interface FixtureDiffFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  patch: string;
}

/**
 * One `git diff` file section, as the forge would hand it over.
 *
 * Used by the fixtures, so they can be real `git diff` output instead of a
 * format invented for tests: a fixture a reviewer cannot paste from a terminal
 * is one nobody will add a near-miss to.
 */
export function parseGitDiff(text: string): FixtureDiffFile[] {
  const files: FixtureDiffFile[] = [];
  const sections = text.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '));
  for (const section of sections) {
    const oldPath = /^--- (?:a\/)?(.+)$/m.exec(section)?.[1]?.trim();
    const newPath = /^\+\+\+ (?:b\/)?(.+)$/m.exec(section)?.[1]?.trim();
    const hunkAt = section.search(/^@@ /m);
    if (!oldPath || !newPath || hunkAt < 0) continue;
    const status =
      oldPath === '/dev/null'
        ? 'added'
        : newPath === '/dev/null'
          ? 'removed'
          : /^rename from /m.test(section)
            ? 'renamed'
            : 'modified';
    files.push({
      path: newPath === '/dev/null' ? oldPath : newPath,
      status,
      patch: section.slice(hunkAt).replace(/\n$/, ''),
    });
  }
  return files;
}
