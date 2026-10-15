import { eq } from 'drizzle-orm';
import { read, type Database, safeErrorText } from '@repopulse/shared';
import type { AnalysisGateway } from '@repopulse/analysis';
import { BudgetExceededError, BudgetMeter } from '../../framework/budget.js';
import type { ScanBudget } from '../../framework/types.js';
import { loadVerifyChecklist } from './checklist.js';
import { buildVerifyPrompt } from './prompt.js';
import { validateVerifyAnswer } from './schema.js';
import { selectForVerify, VERIFY_TOP_N } from './select.js';
import {
  emptyVerifyFunnel,
  type VerifyCandidate,
  type VerifyFunnel,
  type VerifyProposal,
  type VerifyRejection,
} from './types.js';

// V5 — the adversarial verify pass (W8-15, SECURITY_SUITE.md §3.6, FR-SEC-13,
// FR-ANALYSIS-9, E12.3).
//
// MAKER != VERIFIER, and it holds here without arranging a second host. The
// finding was made by grype — a version-range matcher — and it is judged by a
// model that has never seen grype's reasoning, because grype does not have any.
// That is a stronger independence than passes/verify.ts can get when both sides
// are the same reviewer, which is why this pass does not use pickVerifierHost
// and does not need the gateway to expose one.
//
// TIER 2 ONLY, and not by omission. A scheduled pass that could reach a
// third-party API is precisely what the per-repo Tier-3 opt-in exists to stop
// (Law 8); the gateway would refuse a T3 request from a repo that has not
// opted in, and this pass never makes one.
//
// THE RETURN VALUE IS PROPOSALS. Nothing here writes to `findings`. The row's
// `yields` column is composed wholesale by scanners/dependency/findings.ts —
// chainer terms, pricing inputs, V0-V3 evidence, `proposed_vex` — and a second
// writer doing a read-modify-write on it from another module would race the
// next scan's persistFindings and clobber a column two other files own. So V5
// returns its proposals to its caller and the wiring ticket decides where they
// land. That seam is unwired today and is reported as such rather than closed
// with a mutation nobody downstream asked for.

const DIMENSION = 'security' as const;
const INITIATOR = 'scanner:dependency_cve:verify';

export interface VerifyRunDeps {
  db: Database;
  gateway: AnalysisGateway;
  workspaceId: number;
  repoId: number;
  commitSha: string;
  /** The priced, validated population — normally the whole scan's output. */
  candidates: readonly VerifyCandidate[];
  /** Token ceiling for this pass. Only `llmTokens` is spent here. */
  budget: Pick<ScanBudget, 'llmTokens'>;
  /** Top-N cut. Clamped to VERIFY_MAX_CALLS whatever a caller passes. */
  limit?: number;
  /**
   * The find-pass analysis_runs row this verify pass answers, when there is one.
   *
   * NULL FOR A SCHEDULED DEPENDENCY SCAN, and deliberately. `parent_run_id`
   * chains analysis PASSES (find -> verify -> challenge, DATABASE.md D9), and a
   * dependency scan has no find pass: its maker is grype and its provenance
   * lives in `scan_runs`, a different table and a different id space. Putting a
   * scan_runs id in this column would type-check, join to the wrong row, and
   * look fine for months. The scan run is returned on the result instead, where
   * the caller can record the link somewhere that means it.
   */
  parentRunId?: number | null;
  /** The scan_runs row these candidates came from — echoed, never stored here. */
  scanRunId?: number | null;
  prNumber?: number;
  pullRequestId?: number | null;
  checklistDir?: string;
}

export interface VerifyRunResult {
  status: 'succeeded' | 'failed' | 'skipped';
  analysisRunId: number | null;
  /** Echo of deps.scanRunId — the chain the caller has to persist itself. */
  scanRunId: number | null;
  checklistVersion: string;
  /** Every model that answered. A pass can span hosts. */
  models: string[];
  proposals: VerifyProposal[];
  /** Answers thrown away, with the reason. Never silent. */
  rejections: VerifyRejection[];
  funnel: VerifyFunnel;
  /** True when a budget cut the pass short: the proposals are real, the SET is not. */
  partial: boolean;
  promptTokens: number;
  outputTokens: number;
  skippedReason?: 'no_candidates';
  error?: string;
}

/**
 * Runs V5 over the top-N candidates.
 *
 * ONE GATEWAY CALL PER FINDING, sequential, no chunking. A finding's evidence
 * is a few dozen lines, unlike a diff, so there is nothing to chunk — and the
 * calls are sequential because the gateway's concurrency cap is per host and a
 * scheduled pass has no claim on more than one slot of a machine somebody is
 * also using interactively.
 */
export async function runVerifyPass(deps: VerifyRunDeps): Promise<VerifyRunResult> {
  const checklist = loadVerifyChecklist(deps.checklistDir);
  const funnel = emptyVerifyFunnel();
  funnel.candidates = deps.candidates.length;

  const selection = selectForVerify(deps.candidates, deps.limit ?? VERIFY_TOP_N);
  funnel.selected = selection.selected.length;
  for (const skip of selection.skipped) funnel.skipped[skip.reason] += 1;

  if (selection.selected.length === 0) {
    // No analysis_runs row: this pass did not call a model and must not appear
    // to have. A run row with zero chunks would show up in spend accounting as
    // a pass that happened for free, which is a different and wrong story from
    // a pass that had nothing to do.
    return {
      status: 'skipped',
      analysisRunId: null,
      scanRunId: deps.scanRunId ?? null,
      checklistVersion: checklist.version,
      models: [],
      proposals: [],
      rejections: [],
      funnel,
      partial: false,
      promptTokens: 0,
      outputTokens: 0,
      skippedReason: 'no_candidates',
    };
  }

  const startedAt = new Date();
  const [run] = await deps.db
    .insert(read.analysisRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      pullRequestId: deps.pullRequestId ?? null,
      tier: 2,
      dimension: DIMENSION,
      // The CHECKLIST version — it is what asked the questions. The model id is
      // filled in below from the answers, because which model served a T2 call
      // is the host's decision and is only known afterwards.
      checklistVersion: checklist.version,
      modelId: 'pending',
      status: 'running',
      passKind: 'verify',
      ...(deps.parentRunId != null ? { parentRunId: deps.parentRunId } : {}),
      chunkCount: selection.selected.length,
      promptTokens: 0,
      outputTokens: 0,
      startedAt,
    })
    .returning();
  const runId = run!.id;

  const meter = new BudgetMeter({
    wallClockMs: 0,
    forgeCalls: 0,
    llmTokens: deps.budget.llmTokens,
  });
  const proposals: VerifyProposal[] = [];
  const rejections: VerifyRejection[] = [];
  const models = new Set<string>();
  let promptTokens = 0;
  let outputTokens = 0;
  let partial = false;

  try {
    for (const [index, candidate] of selection.selected.entries()) {
      const result = await deps.gateway.complete(
        buildVerifyPrompt(checklist, candidate.vulnerability),
        {
          tier: 'T2',
          // The wrapper enforces the real cap (C2/NFR-8); passing it here
          // keeps the call site honest about which tier's limit applies.
          maxTokens: 45_000,
          expectJson: true,
          meta: {
            repoId: String(deps.repoId),
            prNumber: deps.prNumber ?? 0,
            dimension: DIMENSION,
            checklistVersion: checklist.version,
            // Verify spend must be separable from find spend in the
            // accounting rows, or "what did the verify pass cost" has no
            // answer and the first thing cut will be the wrong thing.
            initiator: INITIATOR,
          },
        },
      );

      models.add(result.model);
      promptTokens += result.tokensIn;
      outputTokens += result.tokensOut;
      funnel.verified += 1;

      recordAnswer(candidate, result.text, result.model, funnel, proposals, rejections);

      // CHARGED AFTER THE ANSWER IS BANKED. Charging first would throw away a
      // proposal we had already paid for; this way the budget stops the NEXT
      // call, which is the one that would exceed it.
      try {
        meter.chargeTokens(result.tokensIn + result.tokensOut);
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        // Partial, not failed. The proposals produced so far are real answers
        // about real findings; the SET is incomplete and says so, and the
        // remaining candidates are counted as skipped rather than vanishing.
        partial = true;
        funnel.skipped.budget_exhausted += selection.selected.length - index - 1;
        break;
      }
    }

    await deps.db
      .update(read.analysisRuns)
      .set({
        status: 'succeeded',
        modelId: [...models].sort().join(',') || 'none',
        chunkCount: funnel.verified,
        promptTokens,
        outputTokens,
        finishedAt: new Date(),
      })
      .where(eq(read.analysisRuns.id, runId));

    return {
      status: 'succeeded',
      analysisRunId: runId,
      scanRunId: deps.scanRunId ?? null,
      checklistVersion: checklist.version,
      models: [...models].sort(),
      proposals,
      rejections,
      funnel,
      partial,
      promptTokens,
      outputTokens,
    };
  } catch (error) {
    const message = safeErrorText(error);
    await deps.db
      .update(read.analysisRuns)
      .set({
        status: 'failed',
        modelId: [...models].sort().join(',') || 'none',
        chunkCount: funnel.verified,
        promptTokens,
        outputTokens,
        error: message.slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(read.analysisRuns.id, runId));

    return {
      status: 'failed',
      analysisRunId: runId,
      scanRunId: deps.scanRunId ?? null,
      checklistVersion: checklist.version,
      models: [...models].sort(),
      // The proposals already validated are RETURNED from a failed pass. They
      // are answers about findings, and a host dying on call seven is not a
      // reason to discard the six that were right.
      proposals,
      rejections,
      funnel,
      partial: true,
      promptTokens,
      outputTokens,
      error: message,
    };
  }
}

/** Parses, grounds and files one answer. Every outcome lands on the funnel. */
function recordAnswer(
  candidate: VerifyCandidate,
  text: string,
  model: string,
  funnel: VerifyFunnel,
  proposals: VerifyProposal[],
  rejections: VerifyRejection[],
): void {
  const vulnerability = candidate.vulnerability;

  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(text));
  } catch {
    funnel.rejected.malformed += 1;
    rejections.push({
      dedupKey: candidate.dedupKey,
      primaryId: vulnerability.primaryId,
      reason: 'malformed',
      detail: `response was not JSON: ${text.slice(0, 120)}`,
    });
    return;
  }

  const validated = validateVerifyAnswer(raw, vulnerability, model);
  if (!validated.ok) {
    funnel.rejected[validated.reason] += 1;
    rejections.push({
      dedupKey: candidate.dedupKey,
      primaryId: vulnerability.primaryId,
      reason: validated.reason,
      detail: validated.detail,
    });
    return;
  }

  funnel.accepted += 1;
  if (validated.proposal) {
    funnel.proposed[validated.proposal.justification] =
      (funnel.proposed[validated.proposal.justification] ?? 0) + 1;
  } else {
    funnel.affirmed += 1;
  }

  proposals.push({
    dedupKey: candidate.dedupKey,
    primaryId: vulnerability.primaryId,
    packageName: vulnerability.packageName,
    applies: validated.answer.applies,
    confidence: validated.answer.confidence,
    model,
    proposal: validated.proposal,
    citedEvidence: validated.citedEvidence,
  });
}

/**
 * Unwraps a ```json fence when the model added one.
 *
 * Not leniency for its own sake: LM Studio models fence JSON constantly even
 * when told not to, and rejecting those as malformed would throw away good
 * answers under a label that means "the model got the question wrong". The
 * fence is formatting; everything inside it still faces the full schema.
 */
function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  return fenced?.[1] ?? text;
}
