import { z } from 'zod';
import { shippedStatusOf, type ShippedStatus } from '../../rules/shadow.js';

// Opengrep output parsing (W8-07, SECURITY_SUITE.md §3.3).
//
// Verified against opengrep 1.27.1 on 2026-08-19 by running it: the shape below
// is what the tool actually emitted, not what its docs describe. `errors` is
// part of that shape and is NOT ignored — a run that failed to load its own
// rulepack still exits with a results array, and an empty one, which is the
// most dangerous thing a scanner can hand back.

export const opengrepOutputSchema = z.object({
  version: z.string().optional(),
  results: z.array(
    z.object({
      check_id: z.string(),
      path: z.string(),
      start: z.object({ line: z.number(), col: z.number().optional() }),
      end: z.object({ line: z.number(), col: z.number().optional() }),
      extra: z.object({
        message: z.string(),
        severity: z.string(),
        metadata: z.record(z.unknown()).default({}),
        fingerprint: z.string().optional(),
        lines: z.string().optional(),
      }),
    }),
  ),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        level: z.string().optional(),
        path: z.string().optional(),
      }),
    )
    .default([]),
  paths: z.object({ scanned: z.array(z.string()).optional() }).optional(),
});

export type OpengrepOutput = z.infer<typeof opengrepOutputSchema>;

export interface SemgrepFinding {
  ruleId: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: number;
  title: string;
  message: string;
  /** From metadata.yields — the chainer's input (W8-09). */
  yields: string[];
  cwe: string | null;
  /**
   * `metadata.lifecycle` from the rule file (CODE_HEALTH_SUITE §8.2): a new
   * rule ships as a `candidate` and its findings run in shadow until promoted.
   * Resolved against the workspace's registry by rules/shadow.ts.
   */
  shippedStatus: ShippedStatus;
}

/**
 * ERROR → 4, WARNING → 3, INFO → 2.
 *
 * Nothing here maps to 5. In this product severity 5 means confirmed and
 * immediately exploitable, and a pattern match over a syntax tree cannot know
 * either — the rule saw a shape, not an exploit. Reserving the top of the scale
 * is what keeps it meaningful when a verified secret or a KEV CVE arrives.
 */
const TITLE_MAX = 120;

/**
 * The first sentence of a rule message, as a list-row title; the rule id when
 * the message is empty.
 *
 * A sentence ends at a full stop followed by whitespace, except after e.g.,
 * i.e., etc., vs. and cf. Not at ! or ?: those are code in our messages
 * (Ruby's `permit!`, Rust's `println!`), and the next sentence often starts
 * with a lower-case identifier ("…a socket stream. readObject runs…"), so no
 * capital is required after the stop. A first sentence over TITLE_MAX ends at
 * its first em dash or colon, or else is clipped at a word.
 */
export function titleFromMessage(message: string, ruleId: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  if (text === '') return ruleId;
  let sentence = text;
  for (const m of text.matchAll(/\.(?=\s)/g)) {
    const before = text.slice(0, m.index).split(' ').at(-1) ?? '';
    if (/^(e\.g|i\.e|etc|vs|cf)$/i.test(before)) continue;
    sentence = text.slice(0, m.index + 1);
    break;
  }
  // A long opening sentence usually names the problem before an em dash or a
  // colon and explains it after; the clause before it is the title.
  if (sentence.length > TITLE_MAX) {
    const breaks = [sentence.indexOf(' — '), sentence.indexOf(': ')].filter(
      (i) => i > 30 && i <= TITLE_MAX,
    );
    if (breaks.length > 0) return `${sentence.slice(0, Math.min(...breaks))}.`;
  }
  if (sentence.length > TITLE_MAX) {
    const cut = sentence.lastIndexOf(' ', TITLE_MAX - 1);
    sentence = `${sentence.slice(0, cut > 40 ? cut : TITLE_MAX - 1)}…`;
  }
  return sentence;
}

export function severityOf(level: string): number {
  switch (level.toUpperCase()) {
    case 'ERROR':
      return 4;
    case 'WARNING':
      return 3;
    default:
      return 2;
  }
}

/**
 * Strips the config-path prefix Opengrep prepends to a rule id.
 *
 * Running with `--config /some/path/pack.yaml` yields check_ids like
 * `some.path.pack.bpm-js-eval-dynamic`. The prefix is an artefact of where the
 * file happened to sit, so it must never reach a stored finding: the same rule
 * run from two different mount points would otherwise dedup as two findings.
 */
export function bareRuleId(checkId: string, knownIds: readonly string[]): string {
  const match = knownIds.find((id) => checkId === id || checkId.endsWith(`.${id}`));
  if (match) return match;
  // Unknown rule: keep the last dot-segment rather than the whole path, and
  // accept the small risk of a rule id containing a dot — the alternative is
  // storing a filesystem path as a rule identifier.
  const segments = checkId.split('.');
  return segments[segments.length - 1] ?? checkId;
}

export interface ParseArgs {
  stdout: string;
  /** Rule ids from the pack we ran, used to un-prefix check_ids. */
  knownRuleIds: readonly string[];
  /** Absolute path the scan ran against, stripped from finding paths. */
  rootDir?: string;
}

export type ParseResult =
  | {
      ok: true;
      findings: SemgrepFinding[];
      scannedFiles: number;
      /** Root-relative paths the engine read (W20-08): what a full run reviewed. */
      scannedPaths: string[];
      toolErrors: string[];
      /** Files an error names (a parse failure): read, but not fully. */
      erroredPaths: string[];
      /** Errors naming no file, such as a rule that failed to load. */
      pathlessErrors: number;
    }
  | { ok: false; error: string };

export function parseOpengrepOutput(args: ParseArgs): ParseResult {
  const trimmed = args.stdout.trim();
  if (trimmed === '') return { ok: false, error: 'opengrep produced no output' };

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, error: `opengrep stdout was not JSON: ${(err as Error).message}` };
  }

  const parsed = opengrepOutputSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'unexpected opengrep output' };
  }

  const root = args.rootDir?.replace(/\/$/, '') ?? '';
  // One match is one finding. Opengrep 1.27.1 reports a taint match once per
  // sink alternative that fires on the same range (measured on the W18-33
  // injection pack: the same range and trace three times), where semgrep
  // 1.181 merges them. Identical rule, file and range is the same match.
  const seen = new Set<string>();
  const unique = parsed.data.results.filter((result) => {
    const key = [
      result.check_id,
      result.path,
      result.start.line,
      result.start.col ?? '',
      result.end.line,
      result.end.col ?? '',
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const findings = unique.map((result) => {
    const metadata = result.extra.metadata as { yields?: unknown; cwe?: unknown };
    const ruleId = bareRuleId(result.check_id, args.knownRuleIds);
    return {
      ruleId,
      file: root && result.path.startsWith(root) ? result.path.slice(root.length + 1) : result.path,
      lineStart: result.start.line,
      lineEnd: result.end.line,
      severity: severityOf(result.extra.severity),
      // The message's FIRST SENTENCE is the title. The whole message is a
      // paragraph of advice and makes a poor list row; the bare id made every
      // performance, logging and rule-pack finding read like
      // "bpm-perf-sw-find-in-loop" (812 rows on the 2026-10-27 walkthrough).
      // Our messages open with a sentence that names the problem ("A Core
      // Data fetch inside a loop."), and the id still has its own column.
      title: titleFromMessage(result.extra.message, ruleId),
      message: result.extra.message.trim(),
      yields: Array.isArray(metadata.yields) ? metadata.yields.map(String) : [],
      cwe: typeof metadata.cwe === 'string' ? metadata.cwe : null,
      shippedStatus: shippedStatusOf(result.extra.metadata, ruleId),
    };
  });

  return {
    ok: true,
    findings,
    scannedFiles: parsed.data.paths?.scanned?.length ?? 0,
    // W20-08 (UX_TODO FND-48): the files the engine actually read, which is
    // what a FULL run may close findings on. Stripped like a finding's path so
    // the two compare.
    scannedPaths: (parsed.data.paths?.scanned ?? []).map((p) =>
      root && p.startsWith(root) ? p.slice(root.length + 1) : p,
    ),
    // Surfaced, never swallowed: a rulepack that failed to load produces zero
    // findings and exit code 0, which is indistinguishable from a clean repo
    // unless someone reads this.
    toolErrors: parsed.data.errors.map((e) => e.message ?? 'unknown opengrep error'),
    // W20-08: what a full run must NOT treat as reviewed. A file that failed to
    // parse was not matched, and a rule that failed to load matched nothing, so
    // findings there are unknown rather than fixed.
    erroredPaths: parsed.data.errors.flatMap((e) =>
      e.path ? [root && e.path.startsWith(root) ? e.path.slice(root.length + 1) : e.path] : [],
    ),
    pathlessErrors: parsed.data.errors.filter((e) => !e.path).length,
  };
}
