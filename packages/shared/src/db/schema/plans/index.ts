import {
  unique,
  boolean,
  bigint,
  smallint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { users } from '../core/users.js';
import { reports } from '../read/reports.js';

// Improvement plans (W5-06, DATABASE.md D9, FR-PLANS-1/2/3).
//
// Team-scoped by construction: there is no person column anywhere below, and
// there must never be one (N-9). A plan item names a repository, a file or a
// finding set — never who is responsible for it. The moment an item can name a
// person, the product becomes a performance-management tool, which the founding
// brief rules out.

export const improvementPlans = pgTable(
  'improvement_plans',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoIds: bigint('repo_ids', { mode: 'number' }).array().notNull(),
    window: text('window').notNull(),
    createdFromReportId: bigint('created_from_report_id', { mode: 'number' }).references(
      () => reports.id,
    ),
    catalogVersion: text('catalog_version').notNull(),
    status: text('status').notNull().default('active'),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('improvement_plans_workspace_id_idx').on(t.workspaceId),
    check('improvement_plans_status_check', sql`${t.status} in ('active', 'archived')`),
  ],
);

export const planItems = pgTable(
  'plan_items',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    planId: bigint('plan_id', { mode: 'number' })
      .notNull()
      .references(() => improvementPlans.id),
    rank: integer('rank').notNull(),
    /** FR-PLANS-1: an item exists ONLY for a catalog entry — no free-form items. */
    catalogId: text('catalog_id').notNull(),
    source: text('source').notNull(),
    /** What the UI links to: metric keys, finding ids, PR ids, file paths. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    recommendation: text('recommendation').notNull(),
    effort: text('effort').notNull(),
    status: text('status').notNull().default('proposed'),
    verifyCriterion: jsonb('verify_criterion').$type<Record<string, unknown>>().notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    statusChangedBy: bigint('status_changed_by', { mode: 'number' }).references(() => users.id),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('plan_items_workspace_plan_status_rank_idx').on(t.workspaceId, t.planId, t.status, t.rank),
    check(
      'plan_items_source_check',
      sql`${t.source} in ('metric', 'finding', 'chain', 'compound', 'agreement')`,
    ),
    check('plan_items_effort_check', sql`${t.effort} in ('S', 'M', 'L')`),
    check(
      'plan_items_status_check',
      sql`${t.status} in ('proposed', 'accepted', 'in_progress', 'done', 'regressed', 'dismissed')`,
    ),
  ],
);

// Every transition, including the automatic ones. A nightly job flipping an
// item to done or regressed with no record is indistinguishable from a human
// doing it, and "why did this reopen?" is the first question anyone asks.
export const planItemEvents = pgTable(
  'plan_item_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    planItemId: bigint('plan_item_id', { mode: 'number' })
      .notNull()
      .references(() => planItems.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    /** null = the nightly verifier, not a person. */
    actorUserId: bigint('actor_user_id', { mode: 'number' }).references(() => users.id),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('plan_item_events_workspace_item_idx').on(t.workspaceId, t.planItemId)],
);

// Working agreements (W5-08, DATABASE.md D9, FR-PLANS-4).
//
// A team's own thresholds over metrics that already exist — the product does
// not invent a standard, it holds the team to the one they set. Exceptions are
// deliberately NOT stored: they are computed from facts at read time over a
// trailing window, so the list is always the current truth rather than a cache
// that can disagree with the pull requests it names.
export const agreements = pgTable(
  'agreements',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoIds: bigint('repo_ids', { mode: 'number' }).array().notNull(),
    kind: text('kind').notNull(),
    threshold: jsonb('threshold').$type<Record<string, unknown>>().notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agreements_workspace_id_idx').on(t.workspaceId),
    check(
      'agreements_kind_check',
      sql`${t.kind} in ('pr_size_max', 'review_within_hours', 'no_unreviewed_merge', 'stale_ceiling', 'ci_pass_floor')`,
    ),
  ],
);

// Artifact intents (W6-07, DATABASE.md D9, FR-PLANS-5).
//
// An intent is a team saying something about a FILE: we mean to refactor this,
// keep an eye on this, or we know and have decided to live with it. The third
// one is why the table exists — without it the only way to stop a known-bad
// file dominating a hotspot list is to pretend it is fine, and people do that
// by ignoring the whole list.
export const fileIntents = pgTable(
  'file_intents',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    path: text('path').notNull(),
    intent: text('intent').notNull(),
    note: text('note'),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** How long a `refactor` intent may sit without improvement before warning. */
    warnAfterMonths: smallint('warn_after_months').notNull().default(3),
  },
  (t) => [
    index('file_intents_workspace_repo_idx').on(t.workspaceId, t.repoId),
    unique('file_intents_workspace_repo_path_key').on(t.workspaceId, t.repoId, t.path),
    check(
      'file_intents_intent_check',
      sql`${t.intent} in ('refactor', 'supervise', 'acknowledged')`,
    ),
  ],
);
