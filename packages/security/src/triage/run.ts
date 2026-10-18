import {
  budgetForContext,
  estimateTokens,
  extractJson,
  type AnalysisGateway,
} from '@repopulse/analysis';
import { proveTriagePatch, type PatchProofDeps } from './patch.js';
import { buildTriagePrompt, loadTriageChecklist } from './prompt.js';
import { validateTriageAnswer } from './schema.js';
import { sliceAround } from './slice.js';
import {
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
  const sliceBudget = Math.max(400, window.promptTokens - overheadTokens(checklist));
  const maxCalls = deps.maxCalls ?? Number.POSITIVE_INFINITY;
  let calls = 0;

  for (const candidate of selected) {
    if (calls >= maxCalls) {
      funnel.skipped.budget_exhausted += 1;
      continue;
    }
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
    const prompt = buildTriagePrompt({
      finding,
      reachability: candidate.reachability,
      slice,
      checklist,
    });
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
          role: 'triage',
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

      const checked = validateTriageAnswer(raw, slice);
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
      const patch =
        a.patchText !== null
          ? await proveTriagePatch(candidate, a.patchText, deps.patchProof)
          : null;
      proposals.push({
        dedupKey: finding.dedupKey,
        verdict: a.verdict,
        confidence: a.confidence,
        model: answer.model,
        checklistVersion: TRIAGE_CHECKLIST_VERSION,
        rationale: a.rationale,
        citations: a.citations,
        vex: a.vex,
        patch,
        route: answer.route
          ? {
              providerName: answer.route.providerName,
              model: answer.route.model,
              linkIndex: answer.route.linkIndex,
            }
          : null,
      });
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

function retryPrompt(original: string, problem: string): string {
  return `${original}\n\nYour previous answer was rejected: ${problem}\nAnswer again with ONLY the required JSON.`;
}
