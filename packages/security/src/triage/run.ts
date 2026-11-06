import {
  budgetForContext,
  estimateTokens,
  extractJson,
  type AnalysisGateway,
  type CompleteResult,
  type LlmRole,
} from '@repopulse/analysis';
import { proveTriagePatch, type PatchProofDeps } from './patch.js';
import { renderContextPacket, type RenderedPacket } from './packet.js';
import { buildTriagePrompt, loadTriageChecklist, type TriagePrompt } from './prompt.js';
import { validateTriageAnswer, type AcceptedAnswer } from './schema.js';
import { sliceAround, type CodeSlice } from './slice.js';
import {
  IMPACT_DIMENSION,
  TRIAGE_CHECKLIST_VERSION,
  emptyTriageFunnel,
  type TriageCandidate,
  type TriageFunnel,
  type TriageProposal,
  type TriageRejection,
} from './types.js';

// Running triage (W19-04). Calls go through the gateway only (Law 8) with
// role 'triage', so the workspace's routing chain, fallback-on-provider-error
// and the local-only switch apply with no code here — tests pin that.

/** Default and ceiling for calls per run. A cap config cannot lift is a cap (V5's rule). */
export const TRIAGE_TOP_N = 10;
export const TRIAGE_MAX_CALLS = 25;
/**
 * Ceiling on the evidence packet's share of the prompt (W22-02), whatever the
 * window: a few definitions, one function and a handful of callers. More is
 * noise the judge has to read past, and time on a local model.
 */
export const PACKET_MAX_TOKENS = 4_000;
/** Kept back from the window for estimate error: estimateTokens is a byte ratio, not a tokenizer. */
export const PROMPT_MARGIN_TOKENS = 64;

export interface TriageDeps {
  gateway: AnalysisGateway;
  /** Smallest probed context window along the triage role's chain; null = unknown. */
  contextWindow?: number | null;
  limit?: number;
  /** Hard cap on gateway calls (retries count). Whole candidates are dropped, never half-asked. */
  maxCalls?: number;
  /** Rule runners for proving a proposed patch. Absent = no patch is ever offered. */
  patchProof?: PatchProofDeps;
  meta: { repoId: string; prNumber: number; initiator: string };
  /**
   * The routing role the calls declare. Default 'triage'; the AI judge's quick
   * first look asks 'triage_fast' (W22-03) with the same prompt and packet.
   */
  role?: Extract<LlmRole, 'triage' | 'triage_fast'>;
}

export interface TriageResult {
  proposals: TriageProposal[];
  rejections: TriageRejection[];
  funnel: TriageFunnel;
  /** Gateway calls made, retries included (W19-09: the pass reports its total). */
  calls: number;
}

/** Prompt overhead outside the slice: checklist + provenance + required JSON. Measured, not guessed. */
function overheadTokens(checklist: string): number {
  return estimateTokens(checklist) + 700;
}

/** What one hit's single-hit call is shown: its slice, its evidence packet and the prompt. */
export interface PreparedTriageHit {
  slice: CodeSlice;
  /** The rendered packet; `text` is in the prompt only when non-empty. */
  packet: RenderedPacket | null;
  prompt: TriagePrompt;
}

/** The slice budget a hit gets: what the window leaves after the fixed prompt. */
export function triageSliceBudget(promptTokens: number, checklist: string): number {
  return Math.max(400, promptTokens - overheadTokens(checklist));
}

/**
 * One hit as its single-hit call shows it. A batched prompt (batch.ts) reuses
 * exactly this slice and packet, so batching never shows a hit less.
 */
export function prepareTriageHit(
  candidate: TriageCandidate,
  promptTokens: number,
  checklist: string,
  sliceBudget: number = triageSliceBudget(promptTokens, checklist),
): PreparedTriageHit {
  const { finding } = candidate;
  const slice = sliceAround(
    candidate.source,
    finding.file,
    finding.lineStart,
    finding.lineEnd,
    sliceBudget,
    undefined,
    candidate.sourceStartLine ?? 1,
  );
  let prompt = buildTriagePrompt({
    finding,
    reachability: candidate.reachability,
    slice,
    checklist,
  });
  // W22-02: the evidence packet gets what the window leaves after the
  // prompt as it stands, never more than its own ceiling; what does not fit
  // is named in the prompt, never silently dropped.
  let packet: RenderedPacket | null = null;
  if (candidate.packet) {
    const room = Math.min(PACKET_MAX_TOKENS, promptTokens - prompt.tokens - PROMPT_MARGIN_TOKENS);
    if (room > 0) {
      packet = renderContextPacket(candidate.packet, finding.file, room);
      if (packet.text) {
        prompt = buildTriagePrompt({
          finding,
          reachability: candidate.reachability,
          slice,
          checklist,
          packetText: packet.text,
        });
      }
    }
  }
  return { slice, packet, prompt };
}

export async function runTriage(
  candidates: readonly TriageCandidate[],
  deps: TriageDeps,
): Promise<TriageResult> {
  const funnel = emptyTriageFunnel();
  const proposals: TriageProposal[] = [];
  const rejections: TriageRejection[] = [];
  funnel.candidates = candidates.length;

  const cap = Math.max(0, Math.min(deps.limit ?? TRIAGE_TOP_N, TRIAGE_MAX_CALLS));
  // Ties break on the dedup key so two runs over the same findings triage the
  // same ones (V5's reason: "why this one last night and not tonight").
  const ordered = [...candidates].sort(
    (a, b) =>
      b.effectiveRisk - a.effectiveRisk || a.finding.dedupKey.localeCompare(b.finding.dedupKey),
  );
  const selected = ordered.slice(0, cap);
  funnel.selected = selected.length;
  funnel.skipped.below_top_n = ordered.length - selected.length;

  const checklist = loadTriageChecklist();
  // The slice may use what the window leaves after the fixed prompt and the
  // answer; unknown window keeps the Tier-2 default budget.
  const window = budgetForContext(deps.contextWindow ?? null);
  const sliceBudget = triageSliceBudget(window.promptTokens, checklist);
  const maxCalls = deps.maxCalls ?? Number.POSITIVE_INFINITY;
  let calls = 0;

  for (const candidate of selected) {
    if (calls >= maxCalls) {
      funnel.skipped.budget_exhausted += 1;
      continue;
    }
    const { finding } = candidate;
    const { slice, packet, prompt } = prepareTriageHit(
      candidate,
      window.promptTokens,
      checklist,
      sliceBudget,
    );
    funnel.triaged += 1;

    let attemptPrompt = prompt.text;
    let lastFailure: { reason: TriageRejection['reason']; detail: string } | null = null;
    let done = false;

    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      if (calls >= maxCalls) break;
      const answer = await deps.gateway.complete(attemptPrompt, {
        tier: 'T2',
        maxTokens: 45_000,
        expectJson: true,
        meta: {
          repoId: deps.meta.repoId,
          prNumber: deps.meta.prNumber,
          dimension: 'security',
          checklistVersion: TRIAGE_CHECKLIST_VERSION,
          initiator: deps.meta.initiator,
          role: deps.role ?? 'triage',
        },
      });
      calls += 1;

      let raw: unknown;
      try {
        raw = extractJson(answer.text);
      } catch (err) {
        lastFailure = {
          reason: 'malformed',
          detail: err instanceof Error ? err.message : String(err),
        };
        attemptPrompt = retryPrompt(prompt.text, lastFailure.detail);
        continue;
      }

      const checked = validateTriageAnswer(raw, slice, packet?.lines);
      if (!checked.ok) {
        lastFailure = { reason: checked.reason, detail: checked.detail };
        // Malformed and uncited answers get one corrective retry; a model that
        // cited a line it was not shown, or contradicted itself, is not asked
        // again — a second try would be shopping for a nicer answer.
        if (checked.reason === 'malformed' || checked.reason === 'uncited') {
          attemptPrompt = retryPrompt(prompt.text, checked.detail);
          continue;
        }
        break;
      }

      const a = checked.answer;
      proposals.push(
        await triageProposalOf(candidate, a, answer, TRIAGE_CHECKLIST_VERSION, deps.patchProof),
      );
      funnel.accepted += 1;
      funnel.verdicts[a.verdict] += 1;
      done = true;
    }

    if (!done) {
      const failure = lastFailure ?? {
        reason: 'malformed' as const,
        detail: 'no answer was obtained within the call budget',
      };
      funnel.rejected[failure.reason] += 1;
      rejections.push({ dedupKey: finding.dedupKey, ...failure });
    }
  }

  return { proposals, rejections, funnel, calls };
}

/** An accepted answer as a proposal (shared by the single-hit and batched calls). */
export async function triageProposalOf(
  candidate: TriageCandidate,
  a: AcceptedAnswer,
  answer: Pick<CompleteResult, 'model' | 'route'>,
  checklistVersion: string,
  patchProof?: PatchProofDeps,
): Promise<TriageProposal> {
  const { finding } = candidate;
  // Impact is asked of performance hits only; one offered elsewhere is not kept.
  const impactAsked = finding.dimension === IMPACT_DIMENSION;
  const patch =
    a.patchText !== null ? await proveTriagePatch(candidate, a.patchText, patchProof) : null;
  return {
    dedupKey: finding.dedupKey,
    verdict: a.verdict,
    confidence: a.confidence,
    model: answer.model,
    checklistVersion,
    rationale: a.rationale,
    citations: a.citations,
    vex: a.vex,
    patch,
    impact: impactAsked ? a.impact : null,
    impactReason: impactAsked ? a.impactReason : null,
    route: answer.route
      ? {
          providerName: answer.route.providerName,
          model: answer.route.model,
          linkIndex: answer.route.linkIndex,
        }
      : null,
  };
}

function retryPrompt(original: string, problem: string): string {
  return `${original}\n\nYour previous answer was rejected: ${problem}\nAnswer again with ONLY the required JSON.`;
}
