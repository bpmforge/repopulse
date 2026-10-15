import { and, eq, inArray } from 'drizzle-orm';
import { read, security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import {
  chunkDiff,
  validateFindings,
  FindingParseError,
  mayBeSurfacedLoudly,
  needsVerification,
  verdictToStatus,
  type AnalysisGateway,
  type DiffFile,
} from '@repopulse/analysis';
import { buildChecklistPrompt, loadChecklist } from '../owasp/checklist.js';
import { docstringInflation, ldrFindings, LDR_FLOOR } from './ldr.js';
import { runSemgrepScan } from '../semgrep/scanner.js';
import {
  ANTI_SLOP_PACK_FILE_PREFIX,
  CODE_HEALTH_PACK_DIR,
  DEFAULT_EXCLUDED_GLOBS,
  isExcluded,
  type PackRunner,
} from '../logging/run.js';

// The anti_slop scanner (W9-03, CODE_HEALTH_SUITE.md §1/§4, FR-CH-3).
//
// TWO LAYERS THAT MUST NOT OVERLAP. The deterministic layer (the W9-01 pack
// plus the LDR arithmetic here) answers what a pattern can settle. The T2
// checklist answers only what it cannot — single-implementation interfaces,
// delegation-only wrappers, speculative generalisation. Asking a model about
// something a regex already decided would produce two findings for one problem
// and make the model the authority on the half it is worst at.

export const ANTI_SLOP_SCANNER_KEY = 'anti_slop';

export interface AntiSlopDeps {
  db: Database;
  /**
   * Absent = deterministic layer only (W9-06).
   *
   * The weekly snapshot pass runs without a model on purpose: LDR and
   * docstring inflation are arithmetic and need no gateway, while the
   * judgement layer needs a T2 host, a budget and an initiator — which is a
   * wiring decision about LLM scheduling, not something to improvise inside a
   * cron. A run with no gateway reports judgment: 0 and says why.
   */
  gateway?: AnalysisGateway;
  workspaceId: number;
  repoId: number;
  commitSha: string;
  /** Diff for pr_synced mode; snapshot files for the weekly pass. */
  files: readonly DiffFile[];
  /** Whole-file sources, for the LDR layer. Diff mode passes none. */
  sources?: readonly { path: string; source: string }[];
  /**
   * The snapshot directory, for the W9-01 pack's anti-slop rules (W18-30).
   * Absent = no pack layer: a diff is not a tree, and the PR path has no
   * snapshot to point the engine at.
   */
  targetDir?: string;
  image?: string;
  /** Defaults to runSemgrepScan; see PackRunner. */
  runPack?: PackRunner;
  excludedGlobs?: readonly string[];
  trigger?: 'pr_synced' | 'schedule' | 'manual';
  pullRequestId?: number | null;
  /** Runs a second, independent judgement. Absent = nothing is surfaced. */
  verify?: (finding: {
    title: string;
    evidenceQuote: string;
    file: string;
  }) => Promise<{ refuted: boolean; reason: string }>;
  checklistDir?: string;
}

export interface AntiSlopResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  deterministic: number;
  /** Of `deterministic`, the `bpm-ch-*` pack findings (W18-30). */
  pack: number;
  /** Pack findings on test, script and fixture paths, dropped. */
  excluded: number;
  judgment: number;
  /** Judgement findings a verifier refuted — kept out, and counted. */
  refuted: number;
  /** Judgement findings nobody could verify: stored, never surfaced loudly. */
  unverified: number;
  findingsCreated: number;
  rejected: number;
  error?: string;
}

/** Slopsquat findings already reported by the secrets/dependency scanners. */
async function existingSlopsquatFiles(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ file: read.findings.file })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        inArray(read.findings.status, ['open', 'confirmed']),
        eq(read.findings.ruleId, 'slopsquat'),
      ),
    );
  return new Set(rows.map((r) => r.file).filter((f): f is string => f !== null));
}

export async function runAntiSlopScan(deps: AntiSlopDeps): Promise<AntiSlopResult> {
  const checklist = loadChecklist('anti_slop', deps.checklistDir);
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: ANTI_SLOP_SCANNER_KEY,
      scannerVersion: checklist.version,
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'manual',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  const findings: IncomingFinding[] = [];
  let rejected = 0;
  let refuted = 0;
  let unverified = 0;
  let pack = 0;
  let excluded = 0;
  let toolVersions: Record<string, string> | null = null;

  try {
    // ---- Deterministic layer -------------------------------------------
    // Files the dependency scanner already flagged as hallucinated packages
    // are SKIPPED here rather than re-reported: FR-CH-3 says cross-link, and
    // two findings for one package is two triage decisions for one problem.
    const alreadyFlagged = await existingSlopsquatFiles(deps.db, deps.workspaceId, deps.repoId);

    const sources = (deps.sources ?? []).filter((s) => !alreadyFlagged.has(s.path));
    for (const ldr of ldrFindings(sources)) {
      findings.push({
        dimension: 'slop',
        severity: 1,
        // 5: the ratio is arithmetic. What is arguable is the floor, and the
        // finding carries the counts so that is what gets argued with.
        confidence: 5,
        file: ldr.file,
        lineStart: 1,
        lineEnd: 1,
        title: `Low logic density: ${ldr.file}`,
        evidenceQuote: `LDR ${ldr.ratio} < ${LDR_FLOOR} (logic ${ldr.breakdown.logic}, overhead ${ldr.breakdown.overhead})`,
        rationale: ldr.message,
        suggestedFix: null,
        scannerKey: ANTI_SLOP_SCANNER_KEY,
        ruleId: ldr.ruleId,
        yields: null,
      });
    }

    for (const source of sources) {
      for (const inflation of docstringInflation(source.path, source.source)) {
        findings.push({
          dimension: 'slop',
          severity: 1,
          confidence: 5,
          file: inflation.file,
          lineStart: 1,
          lineEnd: 1,
          title: `Docstring inflation: ${inflation.symbol}`,
          evidenceQuote: `${inflation.docLines} doc lines over ${inflation.implLines} implementation lines`,
          rationale: inflation.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: inflation.ruleId,
          yields: null,
        });
      }
    }

    // ---- The W9-01 pack, anti-slop rules only (W18-30) -------------------
    // Eight rules that were loaded on every weekly run — by the LOGGING
    // scanner, which dropped them by id — and stored by nobody, while the
    // Code Health tab filtered on `bpm-ch-` waiting for them. They belong here:
    // their dimension is `slop`, and under this scanner key only this
    // scanner's runs can ever own or sweep them.
    if (deps.targetDir) {
      const globs = deps.excludedGlobs ?? DEFAULT_EXCLUDED_GLOBS;
      const result = await (deps.runPack ?? runSemgrepScan)({
        targetDir: deps.targetDir,
        rulepackDir: CODE_HEALTH_PACK_DIR,
        rulepackFiles: (file) => file.startsWith(ANTI_SLOP_PACK_FILE_PREFIX),
        budget: { wallClockMs: 10 * 60 * 1000 },
        ...(deps.image ? { image: deps.image } : {}),
      });
      // Failing the run rather than carrying on with LDR alone: a run that
      // reports `succeeded` with no pack findings is indistinguishable from a
      // repository with no empty catches, and that is the lie W18-30 fixes.
      if (result.status !== 'succeeded') {
        throw new Error(`anti-slop pack run failed: ${result.error ?? result.status}`);
      }
      toolVersions = result.toolVersions;

      for (const finding of result.findings) {
        if (!finding.ruleId.startsWith('bpm-ch-')) continue;
        if (isExcluded(finding.file, globs)) {
          excluded += 1;
          continue;
        }
        pack += 1;
        findings.push({
          dimension: 'slop',
          // The pack tops out at WARNING on purpose; the cap is here so a
          // later rule cannot outrank a vulnerability by mis-tagging itself.
          severity: Math.min(3, finding.severity),
          // 4, not 5: the shape is matched exactly, but several of these
          // rules (try/catch in a loop, what-comments) name their own
          // legitimate exceptions, and the finding cannot see the intent.
          confidence: 4,
          file: finding.file,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          title: finding.title,
          evidenceQuote: `${finding.file}:${finding.lineStart} — ${finding.ruleId}`,
          rationale: finding.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: finding.ruleId,
          yields: null,
        });
      }
    }
    const deterministic = findings.length;

    // ---- Judgement layer -----------------------------------------------
    const chunked = deps.gateway ? chunkDiff(deps.files, 'code_health') : { chunks: [] };
    let judgment = 0;

    for (const chunk of chunked.chunks) {
      const result = await deps.gateway!.complete(buildChecklistPrompt(checklist, chunk.text), {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: String(deps.repoId),
          prNumber: 0,
          // NOT 'slop' (W9-16). This is the GATEWAY's dimension — which Tier-2
          // checklist family the model is being asked to apply — and its union
          // is the four review dimensions, not the finding taxonomy. The
          // findings this call produces are stored as `slop`; the checklist
          // driving it is the code-health one.
          dimension: 'code_health',
          checklistVersion: checklist.version,
          initiator: `scanner:${ANTI_SLOP_SCANNER_KEY}`,
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
        // THE VERIFY GATE (FR-ANALYSIS-9). A judgement finding is a second
        // model's opinion away from being an accusation about someone's code,
        // so it does not reach the store until an independent verifier has had
        // the chance to refute it.
        let verifyStatus: 'unverified' | 'confirmed' | 'contradicted' = 'unverified';
        if (deps.verify && needsVerification(finding.severity)) {
          const verdict = await deps.verify({
            title: finding.title,
            evidenceQuote: finding.evidence_quote,
            file: finding.file,
          });
          verifyStatus = verdictToStatus(verdict);
        }

        if (verifyStatus === 'contradicted') {
          // Dropped entirely, not stored quietly: a refuted structural claim
          // is one the product got wrong, and keeping it in a list "for
          // reference" is how a triage queue fills with things nobody trusts.
          refuted += 1;
          continue;
        }
        if (verifyStatus === 'unverified') unverified += 1;

        judgment += 1;
        findings.push({
          dimension: 'slop',
          // Capped at 3 regardless of what the model said. Structural slop is
          // not exploitable, and a severity-4 wrapper would outrank a real
          // vulnerability in every list that sorts by severity.
          severity: Math.min(3, finding.severity),
          confidence: finding.confidence,
          file: finding.file,
          lineStart: finding.line_range[0],
          lineEnd: finding.line_range[1],
          title: finding.title,
          evidenceQuote: finding.evidence_quote,
          rationale: finding.rationale,
          suggestedFix: finding.suggested_fix,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: 'slop.judgment',
          yields: null,
        });
      }
    }

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: deps.pullRequestId ?? null,
      // Tier 2 even for the deterministic half of this run: the RUN used a
      // model, and a reader sorting by tier is asking "was a model involved",
      // not "which line of this scanner produced it".
      tier: 2,
      findings,
      sweepScannerKey: ANTI_SLOP_SCANNER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'succeeded',
        findingCount: findings.length,
        finishedAt: new Date(),
        ...(toolVersions ? { toolVersions } : {}),
      })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      deterministic,
      pack,
      excluded,
      judgment,
      refuted,
      unverified,
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
      pack: 0,
      excluded,
      judgment: 0,
      refuted,
      unverified,
      findingsCreated: 0,
      rejected,
      error: safeErrorText(err),
    };
  }
}

/** Worst-LDR files first — what the weekly snapshot pass samples. */
export function worstByLdr(
  sources: readonly { path: string; source: string }[],
  limit: number,
): string[] {
  return ldrFindings(sources, 1)
    .sort((a, b) => a.ratio - b.ratio)
    .slice(0, limit)
    .map((f) => f.file);
}

/** Re-export so a caller can ask whether a finding may be shown loudly. */
export { mayBeSurfacedLoudly };
