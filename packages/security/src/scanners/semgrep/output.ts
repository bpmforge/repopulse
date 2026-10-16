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
    .array(z.object({ message: z.string().optional(), level: z.string().optional() }))
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
  | { ok: true; findings: SemgrepFinding[]; scannedFiles: number; toolErrors: string[] }
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
      // The rule id is the title, not the message: the message is a paragraph
      // of advice and makes a poor list row, and the id is what a reader
      // searches for when two findings look the same.
      title: ruleId,
      message: result.extra.message.trim(),
      yields: Array.isArray(metadata.yields) ? metadata.yields.map(String) : [],
      cwe: typeof metadata.cwe === 'string' ? metadata.cwe : null,
      shippedStatus: shippedStatusOf(result.extra.metadata),
    };
  });

  return {
    ok: true,
    findings,
    scannedFiles: parsed.data.paths?.scanned?.length ?? 0,
    // Surfaced, never swallowed: a rulepack that failed to load produces zero
    // findings and exit code 0, which is indistinguishable from a clean repo
    // unless someone reads this.
    toolErrors: parsed.data.errors.map((e) => e.message ?? 'unknown opengrep error'),
  };
}
