import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { users } from '../core/users.js';
import { llmProviders } from '../core/llm-providers.js';
import { findings } from './findings.js';

// The AI pass (W19-09): planned specialists and evidence-fed triage over a
// repository, run through the workspace's own routing chain.
//
// THREE TABLES, ALL WORKSPACE-SCOPED (Law 5), AND NONE OF THEM CAN CHANGE A
// FINDING. A specialist's finding is an ordinary row in `findings` (written by
// persistFindings, dimension and all); what is new is the record of how it was
// raised, the record of each pass, and the triage SUGGESTIONS. A suggestion is a
// row a person reads: accepting or dismissing it is stored here, on the
// suggestion, and the finding's own status moves only when that person uses the
// existing PATCH /findings/:id (D9a: the AI never suppresses, closes or merges).

/**
 * W20-18 (UX_TODO AI-14): 'second_opinion' asks another model to triage ONE
 * finding that already has a suggestion. It is a pass row so it counts toward
 * the daily pass limit and the monthly call count like any other.
 */
export const AI_PASS_MODES = [
  'paths',
  'pull_request',
  'commit_range',
  'second_opinion',
  // W22-03: the AI judges the open rule hits after a scan (CLOSE_THE_LOOP.md).
  'judge',
] as const;
export type AiPassMode = (typeof AI_PASS_MODES)[number];

/** W22-03: 'after_scan' = a judge run the worker queued when a scan finished. */
export const AI_PASS_TRIGGERS = ['manual', 'scheduled', 'after_scan'] as const;
export type AiPassTrigger = (typeof AI_PASS_TRIGGERS)[number];
export const AI_SCHEDULE_FREQUENCIES = ['daily', 'weekly'] as const;
export type AiScheduleFrequency = (typeof AI_SCHEDULE_FREQUENCIES)[number];
export const AI_SCHEDULE_SCOPES = ['paths', 'new_pull_requests'] as const;
export type AiScheduleScope = (typeof AI_SCHEDULE_SCOPES)[number];

export const AI_PASS_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped'] as const;

/**
 * W22-03 (owner decision 2): what bounds a run. 'calls' = the monthly call cap
 * (every pass, and a judge run on a hosted link); 'time' = a judge run on
 * local models only, bounded by the workspace's daily judge minutes and NOT
 * counted on the monthly call cap.
 */
export const AI_PASS_BUDGETS = ['calls', 'time'] as const;
export type AiPassBudget = (typeof AI_PASS_BUDGETS)[number];

/** One pass over one repository. The row a person watches: every failure lands here in words. */
export const aiPassRuns = pgTable(
  'ai_pass_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    requestedBy: bigint('requested_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The snapshot the pass read. NULL until it has one. */
    commitSha: text('commit_sha'),
    /** What the person asked about: file paths or directory prefixes. Bounded - never "everything". */
    paths: jsonb('paths').$type<string[]>().notNull(),
    /** What was reviewed: typed paths at the head, a pull request's diff, or a range of commits. */
    mode: text('mode').$type<AiPassMode>().notNull().default('paths'),
    /** Diff modes: the base (a pull request's base branch, or the range's base commit). */
    baseRef: text('base_ref'),
    /** Diff modes: the head commit reviewed. */
    headRef: text('head_ref'),
    prNumber: integer('pr_number'),
    /** W23-07: 'incremental' = only the hunks changed since the base run's head were reviewed. */
    scope: text('scope').$type<'full' | 'incremental'>().notNull().default('full'),
    /** W23-07: the earlier pass an incremental run stands on (no FK: provenance). */
    baseRunId: bigint('base_run_id', { mode: 'number' }),
    /** W23-07: "id@checklistVersion+..." the pass ran with; incremental only on a match. */
    promptVersion: text('prompt_version'),
    /** Who started it: a person (manual) or a schedule an admin opted a repository into. */
    trigger: text('trigger').$type<AiPassTrigger>().notNull().default('manual'),
    scheduleId: bigint('schedule_id', { mode: 'number' }).references(() => aiPassSchedules.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('pending'),
    /** Machine-readable cause of a failure or skip, e.g. no_gateway, too_large, nothing_relevant. */
    reasonCode: text('reason_code'),
    /** In words, for the screen. */
    reason: text('reason'),
    /** planWaves' answer: which specialists ran and why, which did not and why. */
    plan: jsonb('plan').$type<Record<string, unknown>>(),
    /** Per specialist: calls, findings raised, findings rejected, dropped for the call budget. */
    specialists: jsonb('specialists').$type<Record<string, unknown>>(),
    /** runTriage's funnel, verbatim (its invariants reconcile). NULL = triage did not run. */
    triageFunnel: jsonb('triage_funnel').$type<Record<string, unknown>>(),
    /** Why triage did not run, when it did not (no candidates, no stored context, ...). */
    triageSkipped: text('triage_skipped'),
    /** Gateway calls made, retries included. */
    calls: integer('calls').notNull().default(0),
    /** W22-03: what bounds this run - the monthly call cap, or local judging's time budget. */
    budget: text('budget').$type<AiPassBudget>().notNull().default('calls'),
    /** The analysis_runs rows this pass wrote (one per specialist that raised findings). */
    analysisRunIds: jsonb('analysis_run_ids')
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('ai_pass_runs_workspace_repo_idx').on(t.workspaceId, t.repoId, t.createdAt.desc()),
    check(
      'ai_pass_runs_trigger_check',
      sql`${t.trigger} in (${sql.raw(AI_PASS_TRIGGERS.map((m) => `'${m}'`).join(', '))})`,
    ),
    check(
      'ai_pass_runs_mode_check',
      sql`${t.mode} in (${sql.raw(AI_PASS_MODES.map((m) => `'${m}'`).join(', '))})`,
    ),
    check('ai_pass_runs_scope_check', sql`${t.scope} in ('full', 'incremental')`),
    check(
      'ai_pass_runs_status_check',
      sql`${t.status} in (${sql.raw(AI_PASS_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
    check(
      'ai_pass_runs_budget_check',
      sql`${t.budget} in (${sql.raw(AI_PASS_BUDGETS.map((b) => `'${b}'`).join(', '))})`,
    ),
    // One active pass per repository: a second click returns the first.
    // W22-03: judge runs are outside it (a scan's judge must not block a
    // person's pass) and have their own one-active index.
    uniqueIndex('ai_pass_runs_one_active_key')
      .on(t.workspaceId, t.repoId)
      .where(sql`status in ('pending', 'running') and mode <> 'judge'`),
    uniqueIndex('ai_pass_runs_one_active_judge_key')
      .on(t.workspaceId, t.repoId)
      .where(sql`status in ('pending', 'running') and mode = 'judge'`),
  ],
);

/** How a specialist's finding was raised: which model, which routing link. One row per finding. */
export const aiFindingProvenance = pgTable(
  'ai_finding_provenance',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    findingId: bigint('finding_id', { mode: 'number' })
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    aiPassRunId: bigint('ai_pass_run_id', { mode: 'number' })
      .notNull()
      .references(() => aiPassRuns.id, { onDelete: 'cascade' }),
    specialist: text('specialist').notNull(),
    checklistVersion: text('checklist_version').notNull(),
    model: text('model').notNull(),
    /** RouteRecord: role, connection, model, link index, and the links that failed first. */
    route: jsonb('route').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_finding_provenance_workspace_finding_idx').on(t.workspaceId, t.findingId),
    uniqueIndex('ai_finding_provenance_pass_finding_key').on(t.aiPassRunId, t.findingId),
  ],
);

export const AI_VERDICTS = ['real', 'likely_false_positive', 'needs_human'] as const;
export const AI_DECISIONS = ['accepted', 'dismissed', 'superseded'] as const;
/** W22-03 (2026-10-29): how much a real performance hit matters (triage TRIAGE_IMPACTS). */
export const AI_IMPACTS = ['material', 'negligible', 'unknown'] as const;
/** W22-03 (2026-10-29): which judge pass produced a verdict (the quick first look, or the main route). */
export const AI_JUDGE_PASSES = ['fast', 'full'] as const;
/**
 * W22-14: why the quick first look handed a hit on to the main triage route.
 * low_confidence = a likely false positive under AI_JUDGE_FAST_MIN_CONFIDENCE;
 * not_false_positive = real or needs a human; rejected = the answer failed the
 * checklist; provider_error = the call threw (timeout, refused, ...).
 */
export const AI_JUDGE_FAST_ESCALATIONS = [
  'low_confidence',
  'not_false_positive',
  'rejected',
  'provider_error',
] as const;
/** W22-14: the quick first look's answer on an escalated hit (ai_triage_verdicts.fast_pass). */
export interface AiJudgeFastPass {
  /** Null when it gave no usable answer (rejected, provider_error). */
  verdict: (typeof AI_VERDICTS)[number] | null;
  /** 1-5, null when there was no answer. */
  confidence: number | null;
  reason: (typeof AI_JUDGE_FAST_ESCALATIONS)[number];
  model: string | null;
  /** Wall-clock milliseconds the quick first look took on this hit. */
  ms: number;
}
const VEX = [
  'component_not_present',
  'vulnerable_code_not_present',
  'vulnerable_code_not_in_execute_path',
  'vulnerable_code_cannot_be_controlled_by_adversary',
  'inline_mitigations_already_exist',
] as const;

/**
 * A triage SUGGESTION about one finding (W19-04's TriageProposal, persisted).
 *
 * `decision` is the HUMAN's answer to the suggestion - accepted or dismissed -
 * with who and when. `superseded` is set by a newer pass, never by a person, and
 * carries no decider. NULL means nobody has answered yet. At most one undecided
 * suggestion per finding.
 */
export const aiTriageVerdicts = pgTable(
  'ai_triage_verdicts',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    findingId: bigint('finding_id', { mode: 'number' })
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    aiPassRunId: bigint('ai_pass_run_id', { mode: 'number' })
      .notNull()
      .references(() => aiPassRuns.id, { onDelete: 'cascade' }),
    verdict: text('verdict').notNull(),
    confidence: smallint('confidence').notNull(),
    model: text('model').notNull(),
    checklistVersion: text('checklist_version').notNull(),
    rationale: text('rationale').notNull(),
    /** CitedLine[]: file, line, and OUR copy of the line - never the model's text. */
    citations: jsonb('citations').$type<{ file: string; line: number; text: string }[]>().notNull(),
    vexJustification: text('vex_justification'),
    vexStatement: text('vex_statement'),
    /** The verified diff, when a proof ran and passed. NULL otherwise. */
    patchDiff: text('patch_diff'),
    patchStatus: text('patch_status').notNull().default('not_attempted'),
    patchReason: text('patch_reason'),
    /** RouteRecord of the call that produced it. */
    route: jsonb('route').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decision: text('decision'),
    decidedBy: bigint('decided_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** W20-16 (UX_TODO AI-40): the person's optional "why" with the answer. */
    decisionNote: text('decision_note'),
    /**
     * W20-18 (UX_TODO AI-14): set on a SECOND OPINION - another model's answer
     * about the same finding - to the suggestion it checks. Not answered on its
     * own (the original is), so it is outside the one-open index below.
     */
    secondOpinionOf: bigint('second_opinion_of', { mode: 'number' }).references(
      (): AnyPgColumn => aiTriageVerdicts.id,
      { onDelete: 'cascade' },
    ),
    /**
     * W20-25 (UX_TODO X-10): the AI connection that answered, as a column the
     * finding panel can show as "verified by <model> (<connection>)". SET NULL
     * so removing a connection keeps the record; its name is kept beside it
     * for the same reason finding_events keeps actor_login. `model` above is
     * the model. Null on rows from before this column with no route.
     */
    llmProviderId: bigint('llm_provider_id', { mode: 'number' }).references(() => llmProviders.id, {
      onDelete: 'set null',
    }),
    connectionName: text('connection_name'),
    /**
     * W22-03 (2026-10-29): on a `real` verdict about a PERFORMANCE hit, how much
     * it matters (material / negligible / unknown) and the one-line evidence.
     * NULL on every other row, and on rows from before this column. Negligible
     * keeps verify_status 'confirmed' and the finding's status; it only holds
     * back fix drafting (ai-fix.ts) and changes the label on screen.
     */
    impact: text('impact'),
    impactReason: text('impact_reason'),
    /**
     * W22-03 (2026-10-29): which AI judge pass produced this verdict: 'fast'
     * (the optional triage_fast route cleared it as a likely false positive)
     * or 'full' (the triage route). NULL on AI-pass rows and older rows.
     */
    pass: text('pass'),
    /**
     * W22-14 (2026-10-29): on a 'full' verdict the judge reached after the
     * quick first look escalated, that first look's answer (verdict,
     * confidence, why it escalated, model, ms), so fast-vs-full agreement can
     * be measured (scripts/judge-agreement.mjs). NULL on 'fast' rows, on judge
     * runs with no triage_fast route, on AI-pass rows and on older rows. It
     * never feeds the stored verdict or the finding.
     */
    fastPass: jsonb('fast_pass').$type<AiJudgeFastPass>(),
  },
  (t) => [
    index('ai_triage_verdicts_workspace_finding_idx').on(
      t.workspaceId,
      t.findingId,
      t.createdAt.desc(),
    ),
    uniqueIndex('ai_triage_verdicts_one_open_key')
      .on(t.findingId)
      .where(sql`decision is null and second_opinion_of is null`),
    uniqueIndex('ai_triage_verdicts_pass_finding_key').on(t.aiPassRunId, t.findingId),
    check(
      'ai_triage_verdicts_verdict_check',
      sql`${t.verdict} in (${sql.raw(AI_VERDICTS.map((v) => `'${v}'`).join(', '))})`,
    ),
    check('ai_triage_verdicts_confidence_check', sql`${t.confidence} between 1 and 5`),
    check(
      'ai_triage_verdicts_decision_check',
      sql`${t.decision} is null or ${t.decision} in (${sql.raw(AI_DECISIONS.map((d) => `'${d}'`).join(', '))})`,
    ),
    check(
      'ai_triage_verdicts_vex_check',
      sql`${t.vexJustification} is null or ${t.vexJustification} in (${sql.raw(VEX.map((v) => `'${v}'`).join(', '))})`,
    ),
    // A person decided (accepted/dismissed) => who and when are recorded.
    check(
      'ai_triage_verdicts_decider_check',
      sql`${t.decision} is null or ${t.decision} = 'superseded' or (${t.decidedAt} is not null)`,
    ),
    check(
      'ai_triage_verdicts_impact_check',
      sql`${t.impact} is null or ${t.impact} in (${sql.raw(AI_IMPACTS.map((v) => `'${v}'`).join(', '))})`,
    ),
    check(
      'ai_triage_verdicts_pass_check',
      sql`${t.pass} is null or ${t.pass} in (${sql.raw(AI_JUDGE_PASSES.map((v) => `'${v}'`).join(', '))})`,
    ),
    check('ai_triage_verdicts_fast_pass_check', sql`${t.fastPass} is null or ${t.pass} = 'full'`),
    check(
      'ai_triage_verdicts_patch_check',
      sql`${t.patchStatus} in ('verified', 'rejected', 'failed', 'not_attempted') and (${t.patchDiff} is null or ${t.patchStatus} = 'verified')`,
    ),
  ],
);

/**
 * A repository's opt-in to scheduled passes (W19-12). OFF by default: a row exists
 * only once an admin has saved it, and `enabled` needs the acknowledged egress
 * digest (the CHECK). The digest is of WHERE code would be sent; if the routing
 * changes, the digest no longer matches and the schedule skips (recorded) until an
 * admin acknowledges the new destinations.
 */
export const aiPassSchedules = pgTable(
  'ai_pass_schedules',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    enabled: boolean('enabled').notNull().default(false),
    frequency: text('frequency').$type<AiScheduleFrequency>().notNull().default('weekly'),
    scopeKind: text('scope_kind').$type<AiScheduleScope>().notNull().default('paths'),
    /** scope 'paths': the repository's configured paths. Empty for new pull requests. */
    paths: jsonb('paths')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Digest of the destinations acknowledged at enable time. */
    egressDigest: text('egress_digest'),
    /** The acknowledged destinations, verbatim, for the audit trail and the screen. */
    egressAck: jsonb('egress_ack').$type<Record<string, unknown>>(),
    enabledBy: bigint('enabled_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /**
     * W20-18 (UX_TODO AI-53): when a scheduled pass may start, in whole hours of
     * the SERVER's time zone (start inclusive, end exclusive; an end before the
     * start wraps past midnight). Both null = any time.
     */
    windowStartHour: smallint('window_start_hour'),
    windowEndHour: smallint('window_end_hour'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_pass_schedules_workspace_repo_key').on(t.workspaceId, t.repoId),
    index('ai_pass_schedules_due_idx')
      .on(t.nextRunAt)
      .where(sql`enabled`),
    check(
      'ai_pass_schedules_frequency_check',
      sql`${t.frequency} in (${sql.raw(AI_SCHEDULE_FREQUENCIES.map((m) => `'${m}'`).join(', '))})`,
    ),
    check(
      'ai_pass_schedules_scope_check',
      sql`${t.scopeKind} in (${sql.raw(AI_SCHEDULE_SCOPES.map((m) => `'${m}'`).join(', '))})`,
    ),
    check(
      'ai_pass_schedules_window_check',
      sql`(${t.windowStartHour} is null and ${t.windowEndHour} is null) or (${t.windowStartHour} between 0 and 23 and ${t.windowEndHour} between 0 and 23 and ${t.windowStartHour} <> ${t.windowEndHour})`,
    ),
    check(
      'ai_pass_schedules_enabled_ack_check',
      sql`NOT ${t.enabled} OR (${t.egressDigest} IS NOT NULL AND ${t.enabledAt} IS NOT NULL)`,
    ),
  ],
);

/** The workspace's hard monthly cap on model calls for SCHEDULED passes. */
export const aiPassSettings = pgTable(
  'ai_pass_settings',
  {
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .primaryKey()
      .references(() => workspaces.id),
    monthlyCallCap: integer('monthly_call_cap').notNull().default(300),
    /**
     * W20-18 (UX_TODO AI-77): the workspace-wide "AI off" switch. On, nothing
     * sends source to a model: no pass (manual or scheduled), no second opinion
     * and no verified-fix draft, including one a person asks for.
     */
    aiPaused: boolean('ai_paused').notNull().default(false),
    aiPausedBy: bigint('ai_paused_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    aiPausedAt: timestamp('ai_paused_at', { withTimezone: true }),
    /**
     * W22-03 (owner decision 2): wall-clock minutes local models may spend
     * judging rule hits over a rolling 24 hours. NULL = the server default
     * (AI_JUDGE_MINUTES_PER_DAY). 0 stops local judging.
     */
    judgeMinutesPerDay: integer('judge_minutes_per_day'),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ai_pass_settings_cap_check', sql`${t.monthlyCallCap} between 0 and 100000`),
    check(
      'ai_pass_settings_judge_minutes_check',
      sql`${t.judgeMinutesPerDay} is null or ${t.judgeMinutesPerDay} between 0 and 1440`,
    ),
  ],
);

/** The default monthly cap when a workspace has not set one (about ten full passes). */
export const AI_PASS_DEFAULT_MONTHLY_CAP = 300;
