import {
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

export const AI_PASS_MODES = ['paths', 'pull_request', 'commit_range'] as const;
export type AiPassMode = (typeof AI_PASS_MODES)[number];

export const AI_PASS_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'skipped'] as const;

/** Who started a pass: a person pressing start, or a repository's schedule (W19-12). */
export const AI_PASS_TRIGGERS = ['manual', 'schedule'] as const;
export type AiPassTrigger = (typeof AI_PASS_TRIGGERS)[number];

/** What a schedule reviews: fixed paths at the head, or the commits ingested since its last pass. */
export const AI_SCHEDULE_SCOPES = ['paths', 'new_commits'] as const;
export type AiScheduleScope = (typeof AI_SCHEDULE_SCOPES)[number];

export const AI_SCHEDULE_CADENCES = ['daily', 'weekly'] as const;
export type AiScheduleCadence = (typeof AI_SCHEDULE_CADENCES)[number];

/**
 * A repository's schedule for AI passes (W19-12). One row per repository, OFF
 * until an admin turns it on - and turning it on is an acknowledgement that the
 * repository's code will be sent to the configured models with nobody pressing
 * start. Who acknowledged, when, and which wording they saw are kept on the row;
 * an enabled schedule without them cannot exist (the check below).
 *
 * The schedule only STARTS ordinary passes (`ai_pass_runs`, trigger 'schedule'),
 * so every cap and guarantee of a pass applies unchanged.
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
    scope: text('scope').$type<AiScheduleScope>().notNull().default('new_commits'),
    /** Scope 'paths': what to review each time. Empty for 'new_commits'. */
    paths: jsonb('paths')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    cadence: text('cadence').$type<AiScheduleCadence>().notNull().default('weekly'),
    /** Scheduled passes that may START in one calendar month (UTC); skipped runs do not count. */
    monthlyCap: integer('monthly_cap').notNull().default(4),
    /** Skip the pass unless every model it could reach is on the operator's network. */
    requireLocal: boolean('require_local').notNull().default(true),
    acknowledgedBy: bigint('acknowledged_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    /** Which wording of the acknowledgement was shown (AI_SCHEDULE_ACK_VERSION). */
    ackVersion: text('ack_version'),
    /** 'new_commits': the newest commit the last scheduled pass reviewed. */
    lastHeadSha: text('last_head_sha'),
    /** When the sweep last acted on this schedule, whether it started a pass or recorded a skip. */
    lastScheduledAt: timestamp('last_scheduled_at', { withTimezone: true }),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ai_pass_schedules_workspace_repo_key').on(t.workspaceId, t.repoId),
    check(
      'ai_pass_schedules_scope_check',
      sql`${t.scope} in (${sql.raw(AI_SCHEDULE_SCOPES.map((m) => `'${m}'`).join(', '))})`,
    ),
    check(
      'ai_pass_schedules_cadence_check',
      sql`${t.cadence} in (${sql.raw(AI_SCHEDULE_CADENCES.map((m) => `'${m}'`).join(', '))})`,
    ),
    check('ai_pass_schedules_cap_check', sql`${t.monthlyCap} between 1 and 31`),
    // On means somebody acknowledged it.
    check(
      'ai_pass_schedules_ack_check',
      sql`not ${t.enabled} or (${t.acknowledgedAt} is not null and ${t.ackVersion} is not null)`,
    ),
  ],
);

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
    /** A person (requested_by) or a repository's schedule (schedule_id). */
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
      'ai_pass_runs_mode_check',
      sql`${t.mode} in (${sql.raw(AI_PASS_MODES.map((m) => `'${m}'`).join(', '))})`,
    ),
    check(
      'ai_pass_runs_trigger_check',
      sql`${t.trigger} in (${sql.raw(AI_PASS_TRIGGERS.map((m) => `'${m}'`).join(', '))})`,
    ),
    check(
      'ai_pass_runs_status_check',
      sql`${t.status} in (${sql.raw(AI_PASS_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
    // One active pass per repository: a second click returns the first.
    uniqueIndex('ai_pass_runs_one_active_key')
      .on(t.workspaceId, t.repoId)
      .where(sql`status in ('pending', 'running')`),
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
  },
  (t) => [
    index('ai_triage_verdicts_workspace_finding_idx').on(
      t.workspaceId,
      t.findingId,
      t.createdAt.desc(),
    ),
    uniqueIndex('ai_triage_verdicts_one_open_key')
      .on(t.findingId)
      .where(sql`decision is null`),
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
      'ai_triage_verdicts_patch_check',
      sql`${t.patchStatus} in ('verified', 'rejected', 'failed', 'not_attempted') and (${t.patchDiff} is null or ${t.patchStatus} = 'verified')`,
    ),
  ],
);
