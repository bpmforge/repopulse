import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { attachExcerpts } from '../../excerpt.js';
import { persistFindings, readImportGraph, type IncomingFinding } from '@repopulse/insights';
import {
  chunkDiff,
  validateFindings,
  FindingParseError,
  needsVerification,
  verdictToStatus,
  type AnalysisGateway,
  type DiffFile,
} from '@repopulse/analysis';
import { repoContextFor } from '../context/repo-context.js';
import { buildChecklistPrompt, loadChecklist } from '../owasp/checklist.js';
import { shadowFindings } from '../../rules/shadow.js';
import { listTreeFiles } from '../../snapshot/index.js';
import {
  fullRunSweep,
  runSemgrepScan,
  SEMGREP_RULEPACK_DIR,
  type SemgrepRunArgs,
  type SemgrepRunResult,
} from '../semgrep/scanner.js';
import path from 'node:path';

// logging_hygiene (W9-04, CODE_HEALTH_SUITE.md §3, FR-CH-4).
//
// The deterministic half is the W9-01 pack — the SAME rules, run through the
// same engine, restricted to the logging files. It is not reimplemented here: a
// second copy of "what does a dangerous log call look like" would drift from
// the first, and the first is the one with fixtures.

export const LOGGING_SCANNER_KEY = 'logging_hygiene';

/** The pack lives beside the semgrep one; both are ours (W9-01). */
export const CODE_HEALTH_PACK_DIR = path.resolve(SEMGREP_RULEPACK_DIR, '../code-health');

/**
 * Which files in CODE_HEALTH_PACK_DIR belong to which scanner (W18-30).
 *
 * The directory holds the logging AND anti-slop rules. Until W18-30 this
 * scanner loaded both and kept only `bpm-log-*` by id, and nothing else loaded
 * the directory at all — so the eight `bpm-ch-*` rules were evaluated on every
 * weekly run and stored by nobody (the W9-13 shape, one directory up). Split by
 * FILE NAME, so each scanner pays for its own rules only and language variants
 * (`logging.<lang>.v1.yaml`, `anti-slop.<lang>.v1.yaml`) land on the right side
 * without touching this code. pack.test.ts asserts every file is claimed.
 */
export const LOGGING_PACK_FILE_PREFIX = 'logging.';
export const ANTI_SLOP_PACK_FILE_PREFIX = 'anti-slop.';

/**
 * The engine call, injectable.
 *
 * Production always uses `runSemgrepScan` (the §2.2 sandbox). A test can hand
 * in the same pack run through a local engine binary, so the wiring — which
 * files are loaded, which ids are kept, under which scanner key they are
 * stored — is exercised on a machine without the scan image. Without it every
 * test of that wiring skips there, which is how W9-13 and W18-30 went unseen.
 */
export type PackRunner = (args: SemgrepRunArgs) => Promise<SemgrepRunResult>;

/**
 * Paths whose log calls are not production log calls.
 *
 * The pack excludes these for `console.log` already; this is the RUNNER-level
 * version, so every logging rule gets the same treatment. A scanner that fires
 * on test fixtures is a scanner people filter out entirely, and then it is not
 * catching the handler either.
 */
export const DEFAULT_EXCLUDED_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
  '**/scripts/**',
  '**/fixtures/**',
  '**/*.config.*',
];

export function isExcluded(
  file: string,
  globs: readonly string[] = DEFAULT_EXCLUDED_GLOBS,
): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/**
 * Compiles a glob to a regular expression.
 *
 * The wildcards are substituted through PLACEHOLDERS rather than in sequence.
 * The obvious version has an ordering bug this codebase has now produced twice:
 * replacing the globstar first and the single star second rewrites the star
 * INSIDE the replacement text just produced, so the "any directories" group
 * silently narrows to "one directory whose name has no slash" — and every test
 * file in a subdirectory sails through. The first version of this function did
 * exactly that, and the path-exclusion test is what caught it.
 *
 * (This comment says "globstar" rather than showing it: the literal sequence
 * would close the comment block, which is its own small lesson.)
 */
export function globToRegExp(glob: string): RegExp {
  const GLOBSTAR_DIR = '\u0000GLOBSTAR_DIR\u0000';
  const GLOBSTAR = '\u0000GLOBSTAR\u0000';
  const STAR = '\u0000STAR\u0000';

  const pattern = glob
    .replace(/\*\*\//g, GLOBSTAR_DIR)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, STAR)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .split(GLOBSTAR_DIR)
    .join('(?:.*/)?')
    .split(GLOBSTAR)
    .join('.*')
    .split(STAR)
    .join('[^/]*');

  return new RegExp(`^${pattern}$`);
}

export interface LoggingRunDeps {
  db: Database;
  /** Absent = deterministic pack layer only (W9-06); see anti-slop/run.ts. */
  gateway?: AnalysisGateway;
  workspaceId: number;
  repoId: number;
  commitSha: string;
  /** Diff for pr_synced; the whole tree for the weekly snapshot pass. */
  files: readonly DiffFile[];
  /** A directory to run the pack over. Absent = judgement layer only. */
  targetDir?: string;
  image?: string;
  /** Defaults to runSemgrepScan; see PackRunner. */
  runPack?: PackRunner;
  trigger?: 'pr_synced' | 'schedule' | 'manual';
  pullRequestId?: number | null;
  excludedGlobs?: readonly string[];
  verify?: (finding: {
    title: string;
    evidenceQuote: string;
    file: string;
  }) => Promise<{ refuted: boolean; reason: string }>;
  checklistDir?: string;
}

export interface LoggingRunResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  deterministic: number;
  judgment: number;
  refuted: number;
  excluded: number;
  findingsCreated: number;
  rejected: number;
  error?: string;
}

export async function runLoggingScan(deps: LoggingRunDeps): Promise<LoggingRunResult> {
  const checklist = loadChecklist('logging', deps.checklistDir);
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: LOGGING_SCANNER_KEY,
      scannerVersion: checklist.version,
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'manual',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  const findings: IncomingFinding[] = [];
  const globs = deps.excludedGlobs ?? DEFAULT_EXCLUDED_GLOBS;
  let excluded = 0;
  let rejected = 0;
  let refuted = 0;

  // W20-08 (UX_TODO FND-58): what this run may close. Set only by a pass over
  // a whole tree; a diff-scoped run has seen a handful of files.
  let sweep: ReturnType<typeof fullRunSweep> | null = null;

  try {
    // ---- Deterministic: the W9-01 pack, logging rules only ---------------
    let deterministic = 0;
    if (deps.targetDir) {
      const pack = await (deps.runPack ?? runSemgrepScan)({
        targetDir: deps.targetDir,
        rulepackDir: CODE_HEALTH_PACK_DIR,
        rulepackFiles: (file) => file.startsWith(LOGGING_PACK_FILE_PREFIX),
        budget: { wallClockMs: 10 * 60 * 1000 },
        ...(deps.image ? { image: deps.image } : {}),
      });
      if (pack.status !== 'succeeded') {
        throw new Error(`logging pack run failed: ${pack.error ?? pack.status}`);
      }

      // Only the logging rules. The file filter above should already have
      // guaranteed it; this stays because a misnamed file is the kind of
      // mistake that would otherwise store anti-slop findings under this
      // scanner key, where this scanner's runs would own them. Candidate
      // rules land in shadow and deprecated ones drop out (rules/shadow.ts).
      const logging = await shadowFindings(
        deps.db,
        deps.workspaceId,
        pack.findings.filter((f) => f.ruleId.startsWith('bpm-log-')),
      );
      if (deps.trigger !== 'pr_synced') {
        sweep = fullRunSweep(
          pack,
          logging.map((f) => f.file),
          listTreeFiles(deps.targetDir),
        );
      }
      for (const finding of logging) {
        if (isExcluded(finding.file, globs)) {
          excluded += 1;
          continue;
        }
        deterministic += 1;
        findings.push({
          dimension: 'logging',
          severity: finding.severity,
          confidence: 5,
          file: finding.file,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          title: finding.title,
          evidenceQuote: `${finding.file}:${finding.lineStart} — ${finding.ruleId}`,
          rationale: finding.message,
          suggestedFix: null,
          scannerKey: LOGGING_SCANNER_KEY,
          ruleId: finding.ruleId,
          yields:
            finding.yields.length > 0
              ? Object.fromEntries(finding.yields.map((y) => [y, true]))
              : null,
          ...(finding.experimental !== undefined ? { experimental: finding.experimental } : {}),
        });
      }
    }

    // ---- Judgement: the OWASP A09 checklist -----------------------------
    const scannable = deps.files.filter((f) => !isExcluded(f.path, globs));
    excluded += deps.files.length - scannable.length;

    const chunked = deps.gateway ? chunkDiff(scannable, 'code_health') : { chunks: [] };
    // Callers and callees for each chunk (W18-25). Read once per run, and only
    // when there is a chunk to give them to.
    const graph = chunked.chunks.length
      ? await readImportGraph(deps.db, deps.workspaceId, deps.repoId)
      : null;
    let judgment = 0;

    for (const chunk of chunked.chunks) {
      // The context rides beside the diff, never inside it: chunk.text is what
      // evidence quotes are validated against.
      const prompt = buildChecklistPrompt(checklist, chunk.text, repoContextFor(graph, chunk).text);
      const result = await deps.gateway!.complete(prompt, {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: String(deps.repoId),
          prNumber: 0,
          dimension: 'code_health',
          checklistVersion: checklist.version,
          initiator: `scanner:${LOGGING_SCANNER_KEY}`,
        },
      });

      let parsed;
      try {
        parsed = validateFindings(JSON.parse(result.text), chunk.text);
      } catch (err) {
        if (err instanceof FindingParseError || err instanceof SyntaxError) {
          rejected += 1;
          continue;
        }
        throw err;
      }
      rejected += parsed.rejected.length;

      for (const finding of parsed.findings) {
        if (isExcluded(finding.file, globs)) {
          excluded += 1;
          continue;
        }
        // Same verify gate as every other judgement layer (FR-ANALYSIS-9):
        // "this log line is inadequate" is an opinion about someone's code.
        if (deps.verify && needsVerification(finding.severity)) {
          const verdict = await deps.verify({
            title: finding.title,
            evidenceQuote: finding.evidence_quote,
            file: finding.file,
          });
          if (verdictToStatus(verdict) === 'contradicted') {
            refuted += 1;
            continue;
          }
        }

        judgment += 1;
        findings.push({
          dimension: 'logging',
          // Capped at 3: a missing log line is not itself exploitable. It is
          // what makes the exploitable thing invisible, which is a different
          // and slower harm.
          severity: Math.min(3, finding.severity),
          confidence: finding.confidence,
          file: finding.file,
          lineStart: finding.line_range[0],
          lineEnd: finding.line_range[1],
          title: finding.title,
          evidenceQuote: finding.evidence_quote,
          rationale: finding.rationale,
          suggestedFix: finding.suggested_fix,
          scannerKey: LOGGING_SCANNER_KEY,
          ruleId: 'logging.judgment',
          yields:
            finding.yields.length > 0
              ? Object.fromEntries(finding.yields.map((y) => [y, true]))
              : null,
        });
      }
    }

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: deps.pullRequestId ?? null,
      tier: 2,
      findings: await attachExcerpts(deps.targetDir, findings),
      sweepScannerKey: LOGGING_SCANNER_KEY,
      // The pack's findings only: the judgement half reads a diff (or nothing,
      // with no gateway), so not seeing one of ITS findings again says nothing.
      ...(sweep
        ? {
            reviewedFiles: sweep.reviewedFiles,
            fullSweep: {
              ...sweep.fullSweep,
              keepOpen: (row: { ruleId: string | null }) => row.ruleId === 'logging.judgment',
            },
          }
        : {}),
    });

    await deps.db
      .update(security.scanRuns)
      .set({ status: 'succeeded', findingCount: findings.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      deterministic,
      judgment,
      refuted,
      excluded,
      findingsCreated: persisted.created,
      rejected,
    };
  } catch (err) {
    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'failed',
        error: safeErrorText(err).slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, runId));
    return {
      status: 'failed',
      scanRunId: runId,
      deterministic: 0,
      judgment: 0,
      refuted,
      excluded,
      findingsCreated: 0,
      rejected,
      error: safeErrorText(err),
    };
  }
}
