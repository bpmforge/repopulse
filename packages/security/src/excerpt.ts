import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingFinding } from '@repopulse/insights';

// Code excerpts for findings (W18-32).
//
// While a scan holds the ephemeral snapshot, a few lines around each finding
// are copied out so the web app can show the code without a clone or a forge
// call. This is the one place stored customer code is chosen, so the rules are
// strict and every doubt resolves to NO excerpt:
//
//   - never for a secrets finding, or any rule that names a credential: the
//     whole point of SC-29 is that the value never reaches the database, and a
//     window of lines around it would put it there;
//   - never when the window itself looks like it holds a credential;
//   - never outside the snapshot directory (a `..` path or a symlink out);
//   - never for large or binary files;
//   - small: 8 lines either side, at most 60 lines, 300 characters a line.

export const EXCERPT_RADIUS = 8;
export const EXCERPT_MAX_LINES = 60;
export const EXCERPT_MAX_LINE_CHARS = 300;
export const EXCERPT_MAX_FILE_BYTES = 1024 * 1024;

export interface Excerpt {
  /** 1-based number of the first line in `lines`. */
  startLine: number;
  lines: string;
}

const SECRET_RULE = /(secret|passw|credential|api[-_.]?key|token|private[-_.]?key|hardcoded)/i;

// Shapes of credentials that are unmistakable on sight. Deliberately a few,
// high-precision patterns: this is a backstop behind the rule-id and scanner
// checks, not a second secrets scanner.
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /(?:secret|passw(?:or)?d|token|api[-_]?key|auth)\w*["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
];

/** True when the text holds something that looks like a live credential. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

export async function readExcerpt(params: {
  dir: string;
  file: string;
  lineStart: number;
  lineEnd?: number | null;
  radius?: number;
}): Promise<Excerpt | null> {
  const { dir, file, lineStart } = params;
  if (!Number.isInteger(lineStart) || lineStart < 1) return null;
  const lineEnd = Math.max(lineStart, params.lineEnd ?? lineStart);
  const radius = params.radius ?? EXCERPT_RADIUS;

  try {
    const root = await realpath(dir);
    const abs = path.resolve(root, file);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    // A symlink inside the snapshot could point anywhere. Resolve it and
    // require the real target to stay inside the snapshot too.
    const real = await realpath(abs);
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    const st = await stat(real);
    if (!st.isFile() || st.size > EXCERPT_MAX_FILE_BYTES) return null;

    const buf = await readFile(real);
    if (buf.length > EXCERPT_MAX_FILE_BYTES || buf.includes(0)) return null;
    const all = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    if (lineStart > all.length) return null;

    const first = Math.max(1, lineStart - radius);
    const last = Math.min(all.length, lineEnd + radius, first + EXCERPT_MAX_LINES - 1);
    const picked = all.slice(first - 1, last).map((l) =>
      l.length > EXCERPT_MAX_LINE_CHARS ? `${l.slice(0, EXCERPT_MAX_LINE_CHARS)}…` : l,
    );
    const lines = picked.join('\n');
    if (looksLikeSecret(lines)) return null;
    return { startLine: first, lines };
  } catch {
    // Missing, unreadable or racing with the shred: no excerpt, never a failed scan.
    return null;
  }
}

/**
 * Adds `context` to every finding that has a file and a line and is not about a
 * secret. Findings it leaves alone keep `context` absent, so an existing row's
 * stored lines are not erased by a scanner that merely has nothing to say.
 */
export async function attachExcerpts(
  dir: string | null | undefined,
  findings: readonly IncomingFinding[],
): Promise<IncomingFinding[]> {
  if (!dir) return [...findings];
  return Promise.all(
    findings.map(async (f) => {
      if (f.file === null || f.lineStart === null) return f;
      if (f.scannerKey === 'secrets' || (f.ruleId && SECRET_RULE.test(f.ruleId))) {
        return { ...f, context: null };
      }
      const ex = await readExcerpt({
        dir,
        file: f.file,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
      });
      return { ...f, context: ex };
    }),
  );
}
