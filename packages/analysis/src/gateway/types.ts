// Analysis gateway contracts (W6-01, ANALYSIS_TIERS.md §1, FR-ANALYSIS-1).
//
// Every Tier-2/Tier-3 call in the product goes through this interface (Law 8).
// Not a style preference: the token cap, the warm-up, the retry policy and the
// egress audit all live behind it, so a caller that reached an LLM directly
// would bypass every one of them at once.

import type { LlmRole, RouteRecord } from '../routing/index.js';

export type Tier = 'T2' | 'T3';

export type Dimension =
  | 'code_health'
  | 'security'
  | 'performance'
  | 'test_coverage'
  | 'best_practices'
  | 'ai_slop';

export interface CompleteMeta {
  repoId: string;
  prNumber: number;
  dimension: Dimension;
  checklistVersion: string;
  initiator: string;
  /**
   * The role this call serves (W19-02). Optional: a pass that only declares a
   * `dimension` is routed by it. Passes that are not a dimension — triage,
   * patch, AI-slop judgement — name their role here.
   */
  role?: LlmRole;
}

/**
 * A prompt split at its cache boundary (W23-06). `static` is identical across
 * chunks of one dimension and prompt version; `dynamic` is per chunk.
 */
export interface PromptParts {
  static: string;
  dynamic: string;
}

export const PROMPT_PART_SEPARATOR = '\n\n';

export const joinPromptParts = (parts: PromptParts): string =>
  `${parts.static}${PROMPT_PART_SEPARATOR}${parts.dynamic}`;

/**
 * The parts to send, or null to send `prompt` as one user message.
 *
 * Parts are honoured ONLY when they reassemble to exactly the prompt the
 * caller passed (and so exactly what the egress audit hashed). A caller that
 * appended a retry note to the prompt but forgot to carry it into the parts
 * falls back to the single message instead of silently dropping the note.
 */
export function usablePromptParts(
  prompt: string,
  parts: PromptParts | undefined,
): PromptParts | null {
  if (!parts || parts.static === '' || parts.dynamic === '') return null;
  return joinPromptParts(parts) === prompt ? parts : null;
}

export interface CompleteOpts {
  tier: Tier;
  /** T2 MUST be 45000 (C2/NFR-8) — enforced by the wrapper, not by callers. */
  maxTokens: number;
  /** Findings, not prose. */
  temperature?: number;
  expectJson: true;
  meta: CompleteMeta;
  /**
   * Optional static/dynamic split of the prompt (W23-06). Transports use it to
   * put the static part where a prefix cache can reuse it; the `prompt`
   * argument stays the full text and remains what is audited.
   */
  promptParts?: PromptParts;
}

export interface CompleteResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** null for T2 (it runs on your own LAN and costs nothing per call). */
  costUsd: number | null;
  /**
   * Input tokens served from the provider's prompt cache (W23-06), already
   * counted inside `tokensIn`. 0 when the provider does not report one.
   */
  cacheReadTokens?: number;
  durationMs: number;
  /** Which routing link served this call (W19-02). Absent for Tier-3. */
  route?: RouteRecord;
}

export interface AnalysisGateway {
  complete(prompt: string, opts: CompleteOpts): Promise<CompleteResult>;
  health(tier: Tier): Promise<{ ok: boolean; model?: string }>;
}

/** Thrown when Tier-3 is requested for a repo that has not opted in. */
export class TierNotPermittedError extends Error {
  constructor(readonly repoId: string) {
    super(
      `Tier-3 analysis requires an explicit per-repo opt-in (repo ${repoId}). ` +
        'Refused rather than downgraded to Tier-2: sending a repository to a third party ' +
        'because a flag was missing is exactly the decision that must never be implicit.',
    );
    this.name = 'TierNotPermittedError';
  }
}
