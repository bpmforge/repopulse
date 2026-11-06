import { budgetForContext, type AnalysisGateway, type LlmRole } from '@repopulse/analysis';
import type { PatchProofDeps } from './patch.js';
import {
  buildTriageBatchPrompt,
  loadTriageChecklist,
  type TriageBatchPromptHit,
  type TriagePrompt,
} from './prompt.js';
import {
  PROMPT_MARGIN_TOKENS,
  prepareTriageHit,
  runTriage,
  triageProposalOf,
  type PreparedTriageHit,
  type TriageResult,
} from './run.js';
import { validateTriageAnswer } from './schema.js';
import {
  TRIAGE_BATCH_PROMPT_VERSION,
  emptyTriageFunnel,
  type TriageCandidate,
  type TriageFinding,
  type TriageProposal,
  type TriageRejection,
} from './types.js';

// Several hits of one rule per call (W22-14, 2026-10-30).
//
// Measured live on outline: one hit per call on a local 27B model is about
// five minutes, much of it reading the same checklist, rule and answer shape
// and the model's own preamble. A batch asks up to N hits of ONE rule in one
// prompt. Each hit keeps everything its single-hit call would show (packed
// whole, never cut to make room for another), answers by its own id, and is
// validated on its own against ITS lines only: an item that is missing,
// duplicated or fails the checklist rejects that hit alone. A plan of one hit
// is today's single-hit call (runTriage), unchanged.

/** Hard ceiling on hits per call, whatever the setting asks. */
export const TRIAGE_BATCH_MAX = 8;

export interface TriageBatchHit {
  /** "H1", "H2", ...: the id the model answers by. */
  id: string;
  candidate: TriageCandidate;
  /** What its single-hit call would show: the batch shows exactly this. */
  prepared: PreparedTriageHit;
}

export interface TriageBatchPlan {
  /** The hits this call asks: a prefix of the candidates given. */
  hits: TriageBatchHit[];
  /** Candidates that did not fit (or are of another rule): for another call. */
  left: TriageCandidate[];
  /** The batched prompt; null when one hit, which is asked as today's single-hit call. */
  prompt: TriagePrompt | null;
  contextWindow: number | null;
}

/** One rule = same scanner, rule id and dimension (the dimension decides the impact question). */
export function sameTriageRule(a: TriageFinding, b: TriageFinding): boolean {
  return a.scannerKey === b.scannerKey && a.ruleId === b.ruleId && a.dimension === b.dimension;
}

function promptHit(h: TriageBatchHit): TriageBatchPromptHit {
  const packetText = h.prepared.packet?.text;
  return {
    id: h.id,
    finding: h.candidate.finding,
    reachability: h.candidate.reachability,
    slice: h.prepared.slice,
    ...(packetText ? { packetText } : {}),
  };
}

/**
 * As many of the leading candidates (same rule, at most `maxHits`) as fit the
 * window WHOLE: each hit is prepared at its single-hit budget, and a hit whose
 * section would push the prompt past the window is left for another call. The
 * first hit always goes (alone, it is a single-hit call, which fits by
 * construction).
 */
export function packTriageBatch(
  candidates: readonly TriageCandidate[],
  opts: { contextWindow?: number | null; maxHits: number; checklist?: string },
): TriageBatchPlan {
  const first = candidates[0];
  if (!first) throw new Error('packTriageBatch needs at least one candidate');
  const checklist = opts.checklist ?? loadTriageChecklist();
  const window = budgetForContext(opts.contextWindow ?? null);
  const max = Math.max(1, Math.min(Math.floor(opts.maxHits), TRIAGE_BATCH_MAX, candidates.length));
  const hits: TriageBatchHit[] = [];
  let prompt: TriagePrompt | null = null;
  for (let i = 0; i < max; i++) {
    const c = candidates[i]!;
    if (i > 0 && !sameTriageRule(first.finding, c.finding)) break;
    const hit: TriageBatchHit = {
      id: `H${i + 1}`,
      candidate: c,
      prepared: prepareTriageHit(c, window.promptTokens, checklist),
    };
    if (i === 0) {
      hits.push(hit);
      continue;
    }
    const next = buildTriageBatchPrompt({ hits: [...hits, hit].map(promptHit), checklist });
    if (next.tokens > window.promptTokens - PROMPT_MARGIN_TOKENS) break;
    hits.push(hit);
    prompt = next;
  }
  return {
    hits,
    left: candidates.slice(hits.length),
    prompt: hits.length > 1 ? prompt : null,
    contextWindow: opts.contextWindow ?? null,
  };
}

export type TriageBatchItem =
  { ok: true; raw: unknown } | { ok: false; reason: 'malformed'; detail: string };

function parseLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new SyntaxError('no JSON array in the model output');
  }
}

/**
 * The model's answer, item by item, keyed by the hit ids asked. Every id gets
 * an entry: its one item, or why it has none (no answer, answered twice, or
 * the whole answer was not a JSON array). An item for an id that was not
 * asked is ignored. Nothing here judges the item: that is validateTriageAnswer,
 * run per hit against that hit's own lines.
 */
export function parseTriageBatchAnswer(
  text: string,
  ids: readonly string[],
): Map<string, TriageBatchItem> {
  const out = new Map<string, TriageBatchItem>();
  const all = (detail: string) => {
    for (const id of ids) out.set(id, { ok: false, reason: 'malformed', detail });
    return out;
  };
  let raw: unknown;
  try {
    raw = parseLoose(text);
  } catch (err) {
    return all(
      `the batched answer was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let items: unknown[] | null = null;
  if (Array.isArray(raw)) items = raw;
  else if (raw && typeof raw === 'object') {
    // Tolerated: {"answers":[...]} (one array-valued field), or one bare object.
    const arrays = Object.values(raw).filter(Array.isArray);
    if (arrays.length === 1) items = arrays[0]!;
    else if ('hit' in raw) items = [raw];
  }
  if (items === null) return all('the batched answer was not a JSON array of per-hit answers');

  const found = new Map<string, unknown[]>();
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const id = (it as { hit?: unknown }).hit;
    if (typeof id !== 'string') continue;
    const key = id.trim().toUpperCase();
    if (!ids.includes(key)) continue;
    found.set(key, [...(found.get(key) ?? []), it]);
  }
  for (const id of ids) {
    const mine = found.get(id) ?? [];
    if (mine.length === 1) out.set(id, { ok: true, raw: mine[0] });
    else if (mine.length === 0)
      out.set(id, { ok: false, reason: 'malformed', detail: `no answer for hit ${id}` });
    else
      out.set(id, {
        ok: false,
        reason: 'malformed',
        detail: `hit ${id} was answered ${mine.length} times`,
      });
  }
  return out;
}

export interface TriageBatchDeps {
  gateway: AnalysisGateway;
  meta: { repoId: string; prNumber: number; initiator: string };
  role?: Extract<LlmRole, 'triage' | 'triage_fast'>;
  patchProof?: PatchProofDeps;
  /** Calls a one-hit plan may make (runTriage: the answer and one corrective retry). */
  maxCalls?: number;
}

export interface TriageBatchResult extends TriageResult {
  /** True when the hits went in one batched call; false = today's single-hit call. */
  batched: boolean;
}

/**
 * Ask a packed plan. One hit: runTriage exactly as before (its corrective
 * retry included). Several: ONE call, no batch-level retry; each hit is
 * validated on its own and a rejected hit is reported for the caller to ask
 * again alone. A gateway error throws, as runTriage's does.
 */
export async function runTriageBatch(
  plan: TriageBatchPlan,
  deps: TriageBatchDeps,
): Promise<TriageBatchResult> {
  if (plan.prompt === null) {
    const only = plan.hits[0]!.candidate;
    const single = await runTriage([only], {
      gateway: deps.gateway,
      contextWindow: plan.contextWindow,
      limit: 1,
      meta: deps.meta,
      ...(deps.maxCalls !== undefined ? { maxCalls: deps.maxCalls } : {}),
      ...(deps.role ? { role: deps.role } : {}),
      ...(deps.patchProof ? { patchProof: deps.patchProof } : {}),
    });
    return { ...single, batched: false };
  }

  const answer = await deps.gateway.complete(plan.prompt.text, {
    tier: 'T2',
    maxTokens: 45_000,
    expectJson: true,
    // W27-04: verdicts are short answers; no long reasoning.
    reasoning: 'none',
    meta: {
      repoId: deps.meta.repoId,
      prNumber: deps.meta.prNumber,
      dimension: 'security',
      checklistVersion: TRIAGE_BATCH_PROMPT_VERSION,
      initiator: deps.meta.initiator,
      role: deps.role ?? 'triage',
    },
  });

  const funnel = emptyTriageFunnel();
  funnel.candidates = plan.hits.length;
  funnel.selected = plan.hits.length;
  funnel.triaged = plan.hits.length;
  const proposals: TriageProposal[] = [];
  const rejections: TriageRejection[] = [];
  const items = parseTriageBatchAnswer(
    answer.text,
    plan.hits.map((h) => h.id),
  );
  for (const h of plan.hits) {
    const dedupKey = h.candidate.finding.dedupKey;
    const item = items.get(h.id)!;
    if (!item.ok) {
      funnel.rejected[item.reason] += 1;
      rejections.push({ dedupKey, reason: item.reason, detail: item.detail });
      continue;
    }
    // ITS slice and ITS packet lines only: another hit's lines never count.
    const checked = validateTriageAnswer(item.raw, h.prepared.slice, h.prepared.packet?.lines);
    if (!checked.ok) {
      funnel.rejected[checked.reason] += 1;
      rejections.push({ dedupKey, reason: checked.reason, detail: `${h.id}: ${checked.detail}` });
      continue;
    }
    proposals.push(
      await triageProposalOf(
        h.candidate,
        checked.answer,
        answer,
        TRIAGE_BATCH_PROMPT_VERSION,
        deps.patchProof,
      ),
    );
    funnel.accepted += 1;
    funnel.verdicts[checked.answer.verdict] += 1;
  }
  return { proposals, rejections, funnel, calls: 1, batched: true };
}
