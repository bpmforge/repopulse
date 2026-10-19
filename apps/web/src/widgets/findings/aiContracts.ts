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

export type PassMode = 'paths' | 'pull_request' | 'commit_range';

/** What a pass reviewed, as the API reports it next to an answer. */
export interface PassInfo {
  id: number;
  mode: PassMode;
  pr_number: number | null;
  base_ref: string | null;
  head_ref: string | null;
  commit_sha: string | null;
  paths: string[];
}

export function passLabel(
  p: Pick<PassInfo, 'mode' | 'pr_number' | 'base_ref' | 'head_ref' | 'paths'> | null,
): string {
  if (!p) return 'an unrecorded scope';
  if (p.mode === 'pull_request') {
    return `the diff of pull request #${p.pr_number ?? '?'}${p.base_ref ? ` (base ${p.base_ref}${p.head_ref ? `, head ${p.head_ref.slice(0, 8)}` : ''})` : ''}`;
  }
  if (p.mode === 'commit_range') {
    return `the commits ${(p.base_ref ?? '?').slice(0, 8)}..${(p.head_ref ?? '?').slice(0, 8)}`;
  }
  return p.paths.length > 0 ? `the files ${p.paths.join(', ')}` : 'typed paths';
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
  pass?: PassInfo | null;
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
    pass?: PassInfo | null;
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
  mode?: PassMode;
  paths: string[];
  base_ref?: string | null;
  head_ref?: string | null;
  pr_number?: number | null;
  /** W19-12: a person pressed start, or the repository's schedule did. */
  trigger?: 'manual' | 'schedule';
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
    unreadable?: string[];
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
  commits: 10,
} as const;

// GET/PUT /repos/{id}/ai-pass/schedule (W19-12). Off until an admin turns it on,
// and turning it on is an acknowledgement in the server's own wording.
export type ScheduleScope = 'paths' | 'new_commits';
export type ScheduleCadence = 'daily' | 'weekly';

export interface AiPassSchedule {
  saved: boolean;
  enabled: boolean;
  scope: ScheduleScope;
  paths: string[];
  cadence: ScheduleCadence;
  monthly_cap: number;
  require_local: boolean;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  ack_version: string | null;
  last_scheduled_at: string | null;
  last_head_sha: string | null;
  next_due_at: string | null;
  started_this_month: number;
  updated_at: string | null;
}

export interface AiPassScheduleResponse {
  schedule: AiPassSchedule;
  acknowledgement: { version: string; text: string };
}

export interface AiPassScheduleBody {
  enabled: boolean;
  scope: ScheduleScope;
  paths: string[];
  cadence: ScheduleCadence;
  monthly_cap: number;
  require_local: boolean;
  acknowledge?: string;
}
