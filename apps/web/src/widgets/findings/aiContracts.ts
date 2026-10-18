// What GET /findings/:id/ai and GET /repos/:id/ai-pass send (W19-10). Read
// structurally and defensively: this is a stored record of a model's output, and
// a field a newer pass adds must not break an older screen.

export type AiVerdict = 'real' | 'likely_false_positive' | 'needs_human';
export type AiDecision = 'accepted' | 'dismissed' | 'superseded' | null;

export interface AiRoute {
  providerName?: string;
  model?: string;
  linkIndex?: number;
}

export interface AiCitation {
  file: string;
  line: number;
  /** OUR copy of the line, not the model's quotation of it. */
  text: string;
}

export interface AiSuggestion {
  id: number;
  verdict: AiVerdict;
  confidence: number;
  rationale: string;
  citations: AiCitation[];
  vex: { justification: string; statement: string | null } | null;
  patch: { status: string | null; reason: string | null; diff: string | null };
  model: string | null;
  checklist_version: string | null;
  route: AiRoute | null;
  pass_id: number;
  created_at: string;
  decision: AiDecision;
  decided_by: string | null;
  decided_at: string | null;
}

export interface FindingAi {
  raised_by: {
    specialist: string;
    checklist_version: string | null;
    model: string | null;
    route: AiRoute | null;
    pass_id: number;
  } | null;
  suggestions: AiSuggestion[];
}

export const VERDICT_SENTENCE: Record<AiVerdict, string> = {
  real: 'AI suggests this is a real issue.',
  likely_false_positive: 'AI suggests this may be a false positive.',
  needs_human: 'AI could not decide. A person needs to look.',
};

/** "LM Studio · qwen/qwen3.8-27b", or "a fallback link" when the first choice failed. */
export function routeLabel(route: AiRoute | null, model: string | null): string {
  const name = route?.providerName ?? 'an unrecorded provider';
  const m = route?.model ?? model;
  const via = (route?.linkIndex ?? 0) > 0 ? ' (a fallback link, the first choice failed)' : '';
  return `${name}${m ? ` · ${m}` : ''}${via}`;
}

export type PassStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface AiPassRun {
  id: number;
  status: PassStatus;
  paths: string[];
  commit_sha: string | null;
  reason_code: string | null;
  reason: string | null;
  plan: {
    waves?: { wave: number; specialists: { id: string; reason: string }[] }[];
    skipped?: unknown;
  } | null;
  specialists: {
    usage?: Record<string, { calls?: number; findings?: number }>;
    droppedForBudget?: string[];
    failures?: unknown[];
    filesRead?: number;
  } | null;
  triage_funnel: {
    candidates?: number;
    selected?: number;
    triaged?: number;
    accepted?: number;
    verdicts?: Partial<Record<AiVerdict, number>>;
  } | null;
  triage_skipped: string | null;
  calls: number | null;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

// The caps are the server's (apps/api/src/workers/ai-pass-processor.ts and
// routes/ai-pass). Said on the screen so a refusal is not a surprise.
export const PASS_CAPS = {
  files: 40,
  bytes: 400_000,
  paths: 50,
  calls: 30,
  perDay: 10,
} as const;
