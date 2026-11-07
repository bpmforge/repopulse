import {
  budgetForContext,
  chunkDiff,
  type ChunkBudget,
  type SkippedFile,
} from '../chunker/index.js';
import { buildChunkPrompt } from '../chunker/prompt.js';
import type { AnalysisGateway } from '../gateway/types.js';
import { FindingParseError, validateFindings, type Finding } from '../schema/finding.js';
import type { RouteRecord } from '../routing/index.js';
import { ModelNoAnswerError, ModelTimeoutError, ProviderError } from '../t2/client.js';
import { buildCombinedPrompt, combinedBudget, splitByDimension } from './combined.js';
import { planWaves, type Plan } from './planner.js';
import type { Specialist, SpecialistId } from './registry.js';
import { toDiffFiles, type ReviewInput } from './units.js';

// Running the roster (W19-03).
//
// plan -> for each wave, for each specialist: chunk to THAT specialist's model's
// context window -> one gateway call per chunk -> validate. Calls go through the
// gateway only (Law 8), so routing, the egress audit and local-only apply with
// no code here. A call budget caps the work, dropping later waves first and
// SAYING SO in the result — a run that quietly did less would read as clean.

export interface SpecialistRunDeps {
  gateway: AnalysisGateway;
  /** Probed context window of the model that will serve this specialist; null = unknown. */
  contextWindowFor?: (id: SpecialistId) => number | null;
  /** Hard cap on gateway calls for the whole run. Later waves are dropped first. */
  maxCalls?: number;
  prTitle: string;
  prBody?: string | null;
  meta: { repoId: string; prNumber: number; initiator: string };
  only?: readonly SpecialistId[];
  /** Run `only` specialists regardless of relevance (evaluations). */
  force?: boolean;
  /**
   * W27-05: one call per chunk with every planned checklist (the first look),
   * instead of one call per specialist per chunk. Chunks past the call budget
   * are left out and named in `leftForBudget`; the files are ranked best first.
   */
  combined?: boolean;
}

export interface SpecialistFinding extends Finding {
  specialist: SpecialistId;
  checklistVersion: string;
  /** The routing link that served the call that raised it (W19-09). */
  route: RouteRecord | null;
  /** The model that answered. */
  model: string;
}

/** What one specialist cost and found, for the pass record (W19-09). */
export interface SpecialistUsage {
  calls: number;
  chunks: number;
  tokensIn: number;
  tokensOut: number;
  /** Input tokens served from a provider prompt cache (W23-06); inside tokensIn. */
  cacheReadTokens: number;
  /** Models seen, in order of first use. */
  models: string[];
  findings: number;
  rejected: number;
}

export interface SpecialistRunResult {
  plan: Plan;
  findings: SpecialistFinding[];
  /** Dropped because the quote is not in the code shown — counted, never silent. */
  rejected: { specialist: SpecialistId; reason: string }[];
  /** A chunk that could not be answered or parsed, after one retry. */
  failures: { specialist: SpecialistId; paths: string[]; error: string }[];
  skippedFiles: Map<SpecialistId, SkippedFile[]>;
  /** Specialists dropped for the call budget, so a short run is visible. */
  droppedForBudget: SpecialistId[];
  /** Per specialist that ran: calls, chunks, tokens, models, findings. */
  usage: Partial<Record<SpecialistId, SpecialistUsage>>;
  calls: number;
  routes: RouteRecord[];
  /**
   * W27-05, combined runs only: the specialist whose model served the calls.
   * Its usage carries the calls and tokens; the others carry their findings.
   */
  combinedLead?: SpecialistId;
  /** W27-05, combined runs only: files in chunks the call budget left out. */
  leftForBudget?: string[];
}

/** Strips a code fence or prose around the JSON object, which models add. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new SyntaxError('no JSON object in the model output');
  }
}

/**
 * The checklist decides what was being reviewed, so the dimension is set from
 * the specialist BEFORE validation. Found against a real model: asked for
 * ai_slop it answered `"dimension":"slop"` (the name of the scanner family its
 * checklist cites) — a correct finding rejected over a label.
 */
function withDimension(raw: unknown, dimension: string): unknown {
  const findings = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(findings)) return raw;
  return {
    ...(raw as object),
    findings: findings.map((f) => (f && typeof f === 'object' ? { ...f, dimension } : f)),
  };
}

/**
 * A model call that failed on its own (timed out, or the provider errored)
 * rather than a refusal of the whole pass (policy, tier, no host free). W22-03,
 * measured on gin: the second of two review windows hit the 20-minute timeout
 * and the throw discarded the first window's finished review.
 */
function isPerCallFailure(err: unknown): err is Error {
  return err instanceof ModelTimeoutError || err instanceof ProviderError;
}

export async function runSpecialists(
  input: ReviewInput,
  deps: SpecialistRunDeps,
): Promise<SpecialistRunResult> {
  const files = toDiffFiles(input);
  const plan = planWaves(
    files.map((f) => ({ path: f.path, text: f.patch })),
    deps.only ? { only: deps.only, ...(deps.force ? { force: true } : {}) } : {},
  );

  const result: SpecialistRunResult = {
    plan,
    findings: [],
    rejected: [],
    failures: [],
    skippedFiles: new Map(),
    droppedForBudget: [],
    usage: {},
    calls: 0,
    routes: [],
  };
  const maxCalls = deps.maxCalls ?? Number.POSITIVE_INFINITY;
  if (deps.combined) return runCombined(files, plan, result, maxCalls, deps);
  // A call that failed on its own is recorded against its window and the run
  // goes on. Only when NO call answered at all is the first such error thrown,
  // as before: a host that is down should fail the pass, not read as reviewed.
  let answered = false;
  let firstCallError: Error | null = null;

  for (const { specialists } of plan.waves) {
    for (const { specialist } of specialists) {
      const budget: ChunkBudget = budgetForContext(deps.contextWindowFor?.(specialist.id) ?? null);
      const { chunks, skipped } = chunkDiff(files, specialist.dimension, budget);
      result.skippedFiles.set(specialist.id, skipped);
      const usage: SpecialistUsage = {
        calls: 0,
        chunks: chunks.length,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        models: [],
        findings: 0,
        rejected: 0,
      };

      // All-or-nothing per specialist: half a specialist's chunks would be a
      // partial review presented as the specialist's verdict.
      if (result.calls + chunks.length > maxCalls) {
        result.droppedForBudget.push(specialist.id);
        continue;
      }

      for (const chunk of chunks) {
        const prompt = buildChunkPrompt({
          dimension: specialist.dimension,
          chunk,
          prTitle: deps.prTitle,
          prBody: deps.prBody ?? null,
          version: specialist.checklistVersion,
        });
        const meta = {
          repoId: deps.meta.repoId,
          prNumber: deps.meta.prNumber,
          dimension: specialist.dimension,
          checklistVersion: specialist.checklistVersion,
          initiator: deps.meta.initiator,
          role: specialist.role,
        };

        let attemptPrompt = prompt.text;
        // W23-06: the retry note rides on the DYNAMIC half, so the static
        // prefix stays byte-identical and cacheable across attempts.
        let attemptParts = prompt.parts;
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          let answer: Awaited<ReturnType<AnalysisGateway['complete']>>;
          try {
            answer = await deps.gateway.complete(attemptPrompt, {
              tier: 'T2',
              maxTokens: 45_000,
              expectJson: true,
              meta,
              ...(attemptParts ? { promptParts: attemptParts } : {}),
            });
          } catch (err) {
            if (err instanceof ModelNoAnswerError) {
              // W25-18: the model reasoned and never answered. A per-call
              // failure, not a failed review: retry ONCE asking for a short
              // answer, then record it against this chunk and go on.
              result.calls += 1;
              usage.calls += 1;
              lastError = err.message;
              if (attempt === 0) {
                const retryNote =
                  '\n\nYour previous reply contained reasoning but no answer. Keep your reasoning short and reply with ONLY the required JSON.';
                attemptPrompt = `${prompt.text}${retryNote}`;
                if (prompt.parts) {
                  attemptParts = {
                    static: prompt.parts.static,
                    dynamic: `${prompt.parts.dynamic}${retryNote}`,
                  };
                }
                continue;
              }
              break;
            }
            if (!isPerCallFailure(err)) throw err;
            result.calls += 1;
            usage.calls += 1;
            firstCallError ??= err;
            // No retry: the same prompt to the same slow host times out again.
            lastError = err.message;
            break;
          }
          answered = true;
          result.calls += 1;
          usage.calls += 1;
          usage.tokensIn += answer.tokensIn;
          usage.tokensOut += answer.tokensOut;
          usage.cacheReadTokens += answer.cacheReadTokens ?? 0;
          if (!usage.models.includes(answer.model)) usage.models.push(answer.model);
          if (answer.route) result.routes.push(answer.route);
          try {
            const parsed = validateFindings(
              withDimension(extractJson(answer.text), specialist.dimension),
              chunk.text,
            );
            for (const f of parsed.findings) {
              result.findings.push({
                ...f,
                // The specialist's own dimension, whatever the model wrote: the
                // checklist decides what was being reviewed, not the answer.
                dimension: specialist.dimension,
                specialist: specialist.id,
                checklistVersion: specialist.checklistVersion,
                route: answer.route ?? null,
                model: answer.model,
              });
              usage.findings += 1;
            }
            for (const r of parsed.rejected) {
              result.rejected.push({ specialist: specialist.id, reason: r.reason });
              usage.rejected += 1;
            }
            lastError = '';
            break;
          } catch (err) {
            if (!(err instanceof FindingParseError || err instanceof SyntaxError)) throw err;
            lastError = err.message;
            // ONE retry with the error appended (ANALYSIS_TIERS.md §4), then
            // a recorded failure — never salvage a response known malformed.
            const retryNote = `\n\nYour previous answer was rejected: ${lastError}\nAnswer again with ONLY the required JSON.`;
            attemptPrompt = `${prompt.text}${retryNote}`;
            if (prompt.parts) {
              attemptParts = {
                static: prompt.parts.static,
                dynamic: `${prompt.parts.dynamic}${retryNote}`,
              };
            }
          }
        }
        if (lastError) {
          result.failures.push({ specialist: specialist.id, paths: chunk.paths, error: lastError });
        }
      }
      result.usage[specialist.id] = usage;
    }
  }
  if (!answered && firstCallError) throw firstCallError;
  return result;
}

/**
 * W27-05: every planned checklist in one call per chunk. Same rules as the
 * roster: one retry for a reasoning-only answer, one corrective retry for a
 * malformed one, a per-call failure recorded against its chunk, and a run in
 * which nothing answered fails with the first error.
 */
async function runCombined(
  files: ReturnType<typeof toDiffFiles>,
  plan: Plan,
  result: SpecialistRunResult,
  maxCalls: number,
  deps: SpecialistRunDeps,
): Promise<SpecialistRunResult> {
  const planned: Specialist[] = plan.waves.flatMap((w) => w.specialists.map((p) => p.specialist));
  const lead = planned[0];
  if (!lead) return result;
  result.combinedLead = lead.id;
  // The smallest window among the planned specialists' models bounds the chunk:
  // the lead's model serves the call, but routing may change before it runs.
  const windows = planned
    .map((s) => deps.contextWindowFor?.(s.id) ?? null)
    .filter((w): w is number => w !== null);
  const base = budgetForContext(windows.length > 0 ? Math.min(...windows) : null);
  const { chunks, skipped } = chunkDiff(files, lead.dimension, combinedBudget(base, planned));
  const usageOf = new Map<SpecialistId, SpecialistUsage>();
  for (const s of planned) {
    result.skippedFiles.set(s.id, skipped);
    usageOf.set(s.id, {
      calls: 0,
      chunks: chunks.length,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      models: [],
      findings: 0,
      rejected: 0,
    });
  }
  const leadUsage = usageOf.get(lead.id)!;
  const asked = planned.map((s) => s.dimension);
  const byDimension = new Map(planned.map((s) => [s.dimension as string, s]));
  const meta = {
    repoId: deps.meta.repoId,
    prNumber: deps.meta.prNumber,
    dimension: lead.dimension,
    checklistVersion: lead.checklistVersion,
    initiator: deps.meta.initiator,
    role: lead.role,
  };
  let answered = false;
  let firstCallError: Error | null = null;
  const leftForBudget: string[] = [];

  for (const chunk of chunks) {
    // Each chunk costs at least one call; the files are ranked best first, so
    // the chunks past the cap are the least important and are named.
    if (result.calls >= maxCalls) {
      leftForBudget.push(...chunk.paths.filter((p) => !leftForBudget.includes(p)));
      continue;
    }
    const prompt = buildCombinedPrompt({ specialists: planned, chunk, title: deps.prTitle });
    let attemptPrompt = prompt.text;
    let lastError = '';
    for (let attempt = 0; attempt < 2 && result.calls < maxCalls; attempt++) {
      let answer: Awaited<ReturnType<AnalysisGateway['complete']>>;
      try {
        answer = await deps.gateway.complete(attemptPrompt, {
          tier: 'T2',
          maxTokens: 45_000,
          expectJson: true,
          meta,
        });
      } catch (err) {
        result.calls += 1;
        leadUsage.calls += 1;
        if (err instanceof ModelNoAnswerError) {
          lastError = err.message;
          attemptPrompt = `${prompt.text}\n\nYour previous reply contained reasoning but no answer. Keep your reasoning short and reply with ONLY the required JSON.`;
          continue;
        }
        if (!isPerCallFailure(err)) throw err;
        firstCallError ??= err;
        lastError = err.message;
        break;
      }
      answered = true;
      result.calls += 1;
      leadUsage.calls += 1;
      leadUsage.tokensIn += answer.tokensIn;
      leadUsage.tokensOut += answer.tokensOut;
      leadUsage.cacheReadTokens += answer.cacheReadTokens ?? 0;
      if (answer.route) result.routes.push(answer.route);
      try {
        const split = splitByDimension(extractJson(answer.text), asked);
        const parsed = validateFindings(split.raw, chunk.text);
        for (const given of split.dropped) {
          result.rejected.push({
            specialist: lead.id,
            reason: `dimension "${given}" is not one of the checklists asked`,
          });
          leadUsage.rejected += 1;
        }
        for (const f of parsed.findings) {
          const sp = byDimension.get(f.dimension) ?? lead;
          const usage = usageOf.get(sp.id)!;
          result.findings.push({
            ...f,
            dimension: sp.dimension,
            specialist: sp.id,
            checklistVersion: sp.checklistVersion,
            route: answer.route ?? null,
            model: answer.model,
          });
          usage.findings += 1;
        }
        for (const r of parsed.rejected) {
          result.rejected.push({ specialist: lead.id, reason: r.reason });
          leadUsage.rejected += 1;
        }
        for (const u of usageOf.values()) {
          if (!u.models.includes(answer.model)) u.models.push(answer.model);
        }
        lastError = '';
        break;
      } catch (err) {
        if (!(err instanceof FindingParseError || err instanceof SyntaxError)) throw err;
        lastError = err.message;
        attemptPrompt = `${prompt.text}\n\nYour previous answer was rejected: ${lastError}\nAnswer again with ONLY the required JSON.`;
      }
    }
    if (lastError)
      result.failures.push({ specialist: lead.id, paths: chunk.paths, error: lastError });
  }
  for (const [id, u] of usageOf) result.usage[id] = u;
  result.leftForBudget = leftForBudget;
  if (!answered && firstCallError) throw firstCallError;
  return result;
}
