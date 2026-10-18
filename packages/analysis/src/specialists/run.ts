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
import { planWaves, type Plan } from './planner.js';
import type { SpecialistId } from './registry.js';
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
}

export interface SpecialistFinding extends Finding {
  specialist: SpecialistId;
  checklistVersion: string;
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
  calls: number;
  routes: RouteRecord[];
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
    calls: 0,
    routes: [],
  };
  const maxCalls = deps.maxCalls ?? Number.POSITIVE_INFINITY;

  for (const { specialists } of plan.waves) {
    for (const { specialist } of specialists) {
      const budget: ChunkBudget = budgetForContext(deps.contextWindowFor?.(specialist.id) ?? null);
      const { chunks, skipped } = chunkDiff(files, specialist.dimension, budget);
      result.skippedFiles.set(specialist.id, skipped);

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
        let lastError = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          const answer = await deps.gateway.complete(attemptPrompt, {
            tier: 'T2',
            maxTokens: 45_000,
            expectJson: true,
            meta,
          });
          result.calls += 1;
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
              });
            }
            for (const r of parsed.rejected) {
              result.rejected.push({ specialist: specialist.id, reason: r.reason });
            }
            lastError = '';
            break;
          } catch (err) {
            if (!(err instanceof FindingParseError || err instanceof SyntaxError)) throw err;
            lastError = err.message;
            // ONE retry with the error appended (ANALYSIS_TIERS.md §4), then
            // a recorded failure — never salvage a response known malformed.
            attemptPrompt = `${prompt.text}\n\nYour previous answer was rejected: ${lastError}\nAnswer again with ONLY the required JSON.`;
          }
        }
        if (lastError) {
          result.failures.push({ specialist: specialist.id, paths: chunk.paths, error: lastError });
        }
      }
    }
  }
  return result;
}
