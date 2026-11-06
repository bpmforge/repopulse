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

/**
 * W20-18 (UX_TODO AI-14): 'second_opinion' is another model asked about one finding.
 * W22-03: 'judge' is the AI judging the open rule hits after a scan.
 */
export type PassMode = 'paths' | 'pull_request' | 'commit_range' | 'second_opinion' | 'judge';

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
  if (p.mode === 'judge') {
    return 'the open rule hits, judged after a scan';
  }
  if (p.mode === 'second_opinion') {
    return `one finding in ${p.paths[0] ?? 'a file'}, for a second opinion`;
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
  /** W20-16 (UX_TODO AI-40): the optional "why" given with the answer. */
  decision_note?: string | null;
  /** W20-11 (UX_TODO AI-40): the caller answered it, recently enough to change the answer. */
  can_undo?: boolean;
  /** W20-18 (UX_TODO AI-14): set on a second opinion, to the suggestion it checks. */
  second_opinion_of?: number | null;
}

/** W20-18 (UX_TODO AI-77): the workspace-wide "AI off" switch, as the API reports it. */
export interface AiPause {
  paused: boolean;
  paused_by: string | null;
  paused_at: string | null;
}

/** W20-18 (UX_TODO AI-14): who could give a second opinion, and where it would send code. */
export interface SecondOpinionInfo {
  of: number;
  local_only: boolean;
  tier3_opt_in: boolean;
  choices: {
    provider_id: number;
    provider_name: string;
    host: string | null;
    model: string;
    leaves_network: boolean;
  }[];
  blocked: { provider_name: string; model: string; reason: string }[];
  sends: string;
  passes_today: number;
  passes_per_day: number;
  latest: {
    id: number;
    status: PassStatus;
    reason: string | null;
    created_at: string;
    destination?: { provider_name?: string; model?: string; leaves_network?: boolean } | null;
  } | null;
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
  /** W20-18 (UX_TODO AI-77). */
  ai_paused?: AiPause;
  /** W20-18 (UX_TODO AI-14): null when there is no suggestion to check. */
  second_opinion?: SecondOpinionInfo | null;
}

/** "AI is switched off for this workspace (by alice)": one sentence for every AI screen. */
export function pausedLine(p: AiPause | undefined, what: string): string | null {
  if (!p?.paused) return null;
  return `AI analysis is switched off for this workspace${p.paused_by ? ` by ${p.paused_by}` : ''}, so ${what}. An admin can switch it back on in Settings → Analysis.`;
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
  /** W25-01: 'after_scan' is a first look queued after a repository's first scan. */
  trigger?: 'manual' | 'scheduled' | 'after_scan';
  mode?: PassMode;
  paths: string[];
  base_ref?: string | null;
  head_ref?: string | null;
  pr_number?: number | null;
  /** W23-07: 'incremental' = only the hunks changed since `incremental_since` were re-reviewed. */
  scope?: 'full' | 'incremental';
  incremental_since?: string | null;
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
    /** Specialists whose answer was malformed even after a retry, or that timed out or errored, with the paths they were given and why. */
    failures?: { specialist: string; paths: string[]; error: string }[];
    /** Findings the evidence validator refused (a quote not in the source, a line out of range). */
    rejected?: number;
    filesRead?: number;
    /** W20-16 (AI-85): files in scope that were not read, by reason. */
    filesSkipped?: { unsupported: number; tooLarge: number };
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
  /** W20-18 (UX_TODO AI-53): whole hours of the SERVER's time zone; null = any time. */
  window?: { start_hour: number; end_hour: number } | null;
}

/** "02:00–06:00", hours of the server's zone. */
export function windowLabel(w: { start_hour: number; end_hour: number }): string {
  const h = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return `${h(w.start_hour)}–${h(w.end_hour)}`;
}

export interface ScheduleResponse {
  schedule: ScheduleView | null;
  egress: PassEgress;
  acknowledgement_stale: boolean;
  monthly: { cap: number; used: number; remaining: number };
  limits: { passes_per_day: number; tick_minutes: number };
  /** W20-18 (UX_TODO AI-53): the zone run windows are in, e.g. Europe/London. */
  server_time_zone?: string;
  /** W20-18 (UX_TODO AI-77). */
  ai_paused?: AiPause;
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

// W20-16 (UX_TODO AI-85): in step with AI_PASS_READABLE in
// apps/api/src/workers/ai-pass-sources.ts, which a model review reads — wider
// than the deterministic scanners' list.
export const READABLE_SOURCES =
  'JavaScript and TypeScript (.js, .jsx, .ts, .tsx, .mjs, .cjs, .vue, .svelte), Python, Go (and go.mod), Ruby, Java, Kotlin, Scala, C#, PHP, Rust, Swift, C and C++, Objective-C, Dart, Elixir, shell scripts, Terraform (.tf, .hcl), YAML and SQL';
