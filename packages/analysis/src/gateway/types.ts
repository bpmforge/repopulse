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

export interface CompleteOpts {
  tier: Tier;
  /** T2 MUST be 45000 (C2/NFR-8) — enforced by the wrapper, not by callers. */
  maxTokens: number;
  /** Findings, not prose. */
  temperature?: number;
  expectJson: true;
  meta: CompleteMeta;
}

export interface CompleteResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** null for T2 (it runs on your own LAN and costs nothing per call). */
  costUsd: number | null;
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
