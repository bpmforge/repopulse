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
  /** W20-11 (UX_TODO AI-40): the caller answered it, recently enough to change the answer. */
  can_undo?: boolean;
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
  trigger?: 'manual' | 'scheduled';
  mode?: PassMode;
  paths: string[];
  base_ref?: string | null;
  head_ref?: string | null;
  pr_number?: number | null;
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
    /** Specialists whose answer was malformed even after a retry, with the paths they were given. */
    failures?: { specialist: string; paths: string[]; error: string }[];
    /** Findings the evidence validator refused (a quote not in the source, a line out of range). */
    rejected?: number;
    filesRead?: number;
    unreadable?: string[];
  } | null;
  triage_funnel: {
    candidates?: number;
    selected?: number;
    triaged?: number;
    accepted?: number;
    verdicts?: Partial<Record<AiVerdict, number>>;
    /** W20-11 (UX_TODO AI-82): what was left out, and why. */
    skipped?: { below_top_n?: number; budget_exhausted?: number };
  } | null;
  triage_skipped: string | null;
  calls: number | null;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** At most this many findings get a triage answer per pass (TRIAGE_TOP_N on the server). */
export const TRIAGE_PER_PASS = 10;

/**
 * W20-11 (UX_TODO AI-39): times were printed as the raw UTC string
 * ("2026-10-19 14:05") with no zone, so a reader in Sydney took a 01:05 run
 * for one in their afternoon. Local time, with the zone named.
 */
export function localDateTime(iso: string | null, empty = 'never'): string {
  if (!iso) return empty;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/** Specialist ids as the Routing table names their roles (W20-11, UX_TODO AI-50). */
export const SPECIALIST_LABEL: Record<string, string> = {
  security: 'Security',
  performance: 'Performance',
  code_health: 'Code health',
  best_practices: 'Best practices',
  ai_slop: 'AI slop',
  test_coverage: 'Test coverage',
};
export const specialistLabel = (id: string): string =>
  SPECIALIST_LABEL[id] ?? id.replace(/_/g, ' ');

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

// Scheduled passes (W19-12): what GET /repos/:id/ai-pass/schedule sends.

export interface EgressDestination {
  provider_id: number;
  provider_name: string;
  host: string | null;
  leaves_network: boolean;
  roles: string[];
  /** W20-06 (UX_TODO AI-11): the models this connection would be asked for. */
  models?: string[];
}

export interface PassEgress {
  local_only: boolean;
  destinations: EgressDestination[];
  leaves_network: boolean;
  /** Sent back with an enable request: proof the admin was shown THESE destinations. */
  digest: string;
  sentence: string;
  sends: string;
}

export interface ScheduleView {
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  scope: { kind: 'paths' | 'new_pull_requests'; paths: string[] };
  enabled_by: string | null;
  enabled_at: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
}

export interface ScheduleResponse {
  schedule: ScheduleView | null;
  egress: PassEgress;
  acknowledgement_stale: boolean;
  monthly: { cap: number; used: number; remaining: number };
  limits: { passes_per_day: number; tick_minutes: number };
  runs: {
    id: number;
    status: PassStatus;
    mode: PassMode;
    pr_number: number | null;
    paths: string[];
    reason_code: string | null;
    reason: string | null;
    calls: number | null;
    created_at: string;
    finished_at: string | null;
  }[];
}
