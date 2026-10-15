import { and, eq, inArray } from 'drizzle-orm';
import { read, security, type Database } from '@repopulse/shared';
import {
  persistFindings,
  readImportGraph,
  writeImportGraph,
  type IncomingFinding,
} from '@repopulse/insights';
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
import { repoContextFor } from '../context/repo-context.js';
import { buildChecklistPrompt, loadChecklist } from '../owasp/checklist.js';
import { docstringInflation, ldrFindings, LDR_FLOOR } from './ldr.js';
import { UNUSED_EXPORT_RULE_ID, unusedExports } from './unused-exports.js';
import { PHANTOM_MODULE_RULE_ID, PHANTOM_SYMBOL_RULE_ID, phantomRefs } from './phantom-refs.js';
import { buildImportGraph, RESOLVE_EXTENSIONS } from './source-graph.js';

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
   * The snapshot read hit no cap and skipped no file (W18-02). Only then can a
   * missing module be called missing; absent = assume it was not complete.
   */
  sourcesComplete?: boolean;
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

/**
 * Where a rule sits in this workspace's lifecycle (§8.2), and so whether its
 * findings run in shadow.
 *
 * A rule that ships in code starts as a candidate: it runs on real scans with
 * its findings stamped experimental until an admin promotes it on evidence.
 * No registry row means nobody has decided yet, which is the shipped default.
 */
async function shippedRuleStatus(
  db: Database,
  workspaceId: number,
  ruleId: string,
): Promise<'candidate' | 'active' | 'deprecated'> {
  const [row] = await db
    .select({ status: security.ruleRegistry.status })
    .from(security.ruleRegistry)
    .where(
      and(
        eq(security.ruleRegistry.workspaceId, workspaceId),
        eq(security.ruleRegistry.ruleId, ruleId),
      ),
    )
    .limit(1);
  if (row?.status === 'active' || row?.status === 'deprecated') return row.status;
  return 'candidate';
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

  try {
    // ---- Deterministic layer -------------------------------------------
    // Files the dependency scanner already flagged as hallucinated packages
    // are SKIPPED here rather than re-reported: FR-CH-3 says cross-link, and
    // two findings for one package is two triage decisions for one problem.
    const alreadyFlagged = await existingSlopsquatFiles(deps.db, deps.workspaceId, deps.repoId);

    const sources = (deps.sources ?? []).filter((s) => !alreadyFlagged.has(s.path));

    // The import graph (W18-25), written down for the two consumers that run
    // after this snapshot is gone: the reprice (exposure) and Tier-2 prompts
    // (callers and callees). Built from ALL sources, not the slopsquat-filtered
    // set: a file being flagged does not stop other files importing it.
    if (deps.sources?.length) {
      await writeImportGraph(deps.db, {
        workspaceId: deps.workspaceId,
        repoId: deps.repoId,
        snapshot: {
          version: 1,
          commitSha: deps.commitSha,
          complete: deps.sourcesComplete === true,
          extensions: RESOLVE_EXTENSIONS,
          ...buildImportGraph(deps.sources),
        },
      });
    }

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
    // Dead exports (W18-01) — whole-tree, so the snapshot pass only: a diff
    // cannot say that nothing else imports a name.
    const unusedStatus = sources.length
      ? await shippedRuleStatus(deps.db, deps.workspaceId, UNUSED_EXPORT_RULE_ID)
      : 'deprecated';
    if (unusedStatus !== 'deprecated') {
      for (const unused of unusedExports(sources)) {
        findings.push({
          dimension: 'slop',
          severity: 1,
          // 4, not 5: two independent signals agree, but a consumer outside
          // this repository is something neither of them can see.
          confidence: 4,
          file: unused.file,
          lineStart: unused.line,
          lineEnd: unused.line,
          title: `Unused export: ${unused.name}`,
          evidenceQuote: unused.declaration,
          rationale: unused.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: unused.ruleId,
          yields: null,
          experimental: unusedStatus !== 'active',
        });
      }
    }
    // Phantom references (W18-02): imports of names or modules the
    // repository does not have. Bugs, not taste — severity 3.
    if (sources.length) {
      const statuses = {
        [PHANTOM_SYMBOL_RULE_ID]: await shippedRuleStatus(
          deps.db,
          deps.workspaceId,
          PHANTOM_SYMBOL_RULE_ID,
        ),
        [PHANTOM_MODULE_RULE_ID]: await shippedRuleStatus(
          deps.db,
          deps.workspaceId,
          PHANTOM_MODULE_RULE_ID,
        ),
      };
      for (const ref of phantomRefs(sources, { complete: deps.sourcesComplete === true })) {
        const status = statuses[ref.ruleId];
        if (status === 'deprecated') continue;
        findings.push({
          dimension: 'slop',
          severity: 3,
          confidence: 5,
          file: ref.file,
          lineStart: ref.line,
          lineEnd: ref.line,
          title:
            ref.name === null
              ? `Import of a missing module: ${ref.specifier}`
              : `Import of a name that does not exist: ${ref.name} from ${ref.specifier}`,
          evidenceQuote: ref.statement,
          rationale: ref.message,
          suggestedFix: null,
          scannerKey: ANTI_SLOP_SCANNER_KEY,
          ruleId: ref.ruleId,
          yields: null,
          experimental: status !== 'active',
        });
      }
    }
    const deterministic = findings.length;

    // ---- Judgement layer -----------------------------------------------
    const chunked = deps.gateway ? chunkDiff(deps.files, 'code_health') : { chunks: [] };
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
      .set({ status: 'succeeded', findingCount: findings.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      deterministic,
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
        error: (err as Error).message.slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, runId));
    return {
      status: 'failed',
      scanRunId: runId,
      deterministic: 0,
      judgment: 0,
      refuted,
      unverified,
      findingsCreated: 0,
      rejected,
      error: (err as Error).message,
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
