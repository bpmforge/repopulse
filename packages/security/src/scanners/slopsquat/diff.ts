// Unified-diff helpers for diff mode (W21-05).

/** New-side line numbers of every `+` line in a unified patch. */
export function addedLineNumbers(patch: string): Set<number> {
  const added = new Set<number>();
  let next = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      added.add(next);
      next += 1;
    } else if (raw.startsWith('-')) {
      // old side only
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      next += 1;
    }
  }
  return added;
}

/**
 * The whole new file, rebuilt from the patch of a file the change ADDED.
 *
 * An added file's patch is one hunk of `+` lines, so it already holds the
 * file and no fetch is needed. Null for anything else, or for a patch that
 * does not start at line 1.
 */
export function addedFileText(patch: string): string | null {
  const body: string[] = [];
  let started = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -0,0 \+1(?:,\d+)? @@/.exec(raw);
    if (!started) {
      if (hunk) started = true;
      else if (/^@@/.test(raw)) return null;
      continue;
    }
    if (/^@@/.test(raw)) return null;
    if (raw.startsWith('+')) body.push(raw.slice(1));
    else if (raw.startsWith('\\') || raw === '') continue;
    else return null;
  }
  return started ? body.join('\n') : null;
}
