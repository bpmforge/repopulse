import {
  basenameMatches,
  findExec,
  parseJsonStream,
  relativeTo,
  type AdapterContext,
  type AdapterFinding,
  type ToolAdapter,
} from './types.js';

// shellcheck adapter (W18-26, GPL-3.0 — run as a subprocess only, never linked
// or modified; DESIGN_REVIEW.md §4 records the distribution obligation).
// Verified against shellcheck 0.11.0 by running it on the fixtures under
// fixtures/adapters/shellcheck inside an alpine 3.20 root (the scan image's
// base); fixtures/adapters/recorded holds that output.

/** Extensions shellcheck can parse. zsh is not one of them (SC1071). */
const SHELL_PATTERNS = ['*.sh', '*.bash', '*.ksh'];

/**
 * Codes dropped even at warning level, each for a stated reason.
 *
 * SC2154 "var is referenced but not assigned" is the classic false positive in
 * deploy and CI scripts, whose variables arrive from the caller's environment
 * by design; reporting every one teaches a reader to skip the tool. SC1071 is
 * shellcheck refusing a zsh script, which is a fact about the tool, not a
 * defect in the script. SC1090/SC1091 are "could not follow a sourced file" —
 * the sandbox runs without -x, so that is always true and never actionable.
 */
const DROPPED_CODES = new Set([1071, 1090, 1091, 2154]);

/** shellcheck levels we keep, and what each is worth. Info and style are taste. */
const SEVERITY_BY_LEVEL: Record<string, number> = { error: 3, warning: 2 };

interface ShellcheckComment {
  file?: unknown;
  line?: unknown;
  endLine?: unknown;
  level?: unknown;
  code?: unknown;
  message?: unknown;
}

export const shellcheckAdapter: ToolAdapter = {
  key: 'shellcheck',
  version: '0.11.0',
  license: 'GPL-3.0-only (subprocess only)',
  shadow: true,

  detect(ctx: AdapterContext): boolean {
    // Extension only. A script with a shebang and no extension is missed —
    // detect() sees file names, not contents, and reading every extensionless
    // file to look for a shebang would be a second walk of the snapshot.
    return ctx.files.some((file) => basenameMatches(file, SHELL_PATTERNS));
  },

  command(ctx: AdapterContext): string[] {
    return findExec(ctx.mountPath, SHELL_PATTERNS, [
      'shellcheck',
      '--format=json1',
      // Warning and above: info and style (quoting advice, `$(...)` over
      // backticks) are the bulk of shellcheck's output and are opinions.
      '--severity=warning',
      // No .shellcheckrc: a repository's own config would decide what our
      // scanner reports (same reasoning as ruff's --isolated). In-file
      // `# shellcheck disable=` directives still apply — those are the
      // author's statement about one line, not a repo-wide off switch.
      '--norc',
    ]);
  },

  parse(stdout: string, ctx: AdapterContext): AdapterFinding[] {
    const out: AdapterFinding[] = [];
    for (const doc of parseJsonStream(stdout)) {
      if (!doc || typeof doc !== 'object' || !('comments' in doc)) continue;
      const comments = (doc as { comments: unknown }).comments;
      if (!Array.isArray(comments)) continue;
      for (const raw of comments as ShellcheckComment[]) {
        if (typeof raw?.code !== 'number' || DROPPED_CODES.has(raw.code)) continue;
        const severity = SEVERITY_BY_LEVEL[String(raw.level)];
        if (severity === undefined) continue;
        const code = `SC${raw.code}`;
        const message = typeof raw.message === 'string' ? raw.message : '';
        const line = typeof raw.line === 'number' ? raw.line : 1;
        out.push({
          ruleId: `tool.shellcheck.${code}`,
          file: relativeTo(ctx.mountPath, typeof raw.file === 'string' ? raw.file : ''),
          lineStart: line,
          lineEnd: typeof raw.endLine === 'number' ? raw.endLine : line,
          severity,
          title: `${code}: ${message}`.slice(0, 120),
          message,
          dimension: 'correctness',
          nativeRule: code,
        });
      }
    }
    return out;
  },
};
