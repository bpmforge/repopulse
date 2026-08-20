import { bigint, boolean, check, index, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { users } from '../core/users.js';

// Scanner configuration and runs (W8-01, SECURITY_SUITE.md §1, FR-SEC-11).

export const repoScannerConfig = pgTable(
  'repo_scanner_config',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    scannerKey: text('scanner_key').notNull(),
    /**
     * An explicit row beats the workspace default in BOTH directions. A repo
     * that opted out must stay out even if the default later flips on — which
     * is why enablement is a stored boolean rather than an absence.
     */
    enabled: boolean('enabled').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('repo_scanner_config_workspace_repo_idx').on(t.workspaceId, t.repoId),
    unique('repo_scanner_config_workspace_repo_scanner_key').on(t.workspaceId, t.repoId, t.scannerKey),
  ],
);

export const scanRuns = pgTable(
  'scan_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    scannerKey: text('scanner_key').notNull(),
    /** Scanner + rulepack version — a finding is only reproducible with it. */
    scannerVersion: text('scanner_version').notNull(),
    commitSha: text('commit_sha').notNull(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull(),
    /** True when a budget cut the run short — the findings are real, the SET is not. */
    partial: boolean('partial').notNull().default(false),
    findingCount: bigint('finding_count', { mode: 'number' }).notNull().default(0),
    error: text('error'),
    /**
     * Tool + rulepack versions for this run (W8-07, SECURITY_SUITE §3.3).
     *
     * scanner_version above is one string and cannot carry both: a semgrep
     * finding is reproducible only against an engine version AND a pack
     * version, and "which of the two changed" is the first question when a
     * finding appears or disappears between runs.
     */
    toolVersions: jsonb('tool_versions').$type<Record<string, string>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('scan_runs_workspace_repo_idx').on(t.workspaceId, t.repoId),
    check(
      'scan_runs_status_check',
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'budget_exceeded')`,
    ),
    check(
      'scan_runs_trigger_check',
      sql`${t.trigger} in ('pr_synced', 'push', 'schedule', 'manual')`,
    ),
  ],
);

// SBOMs (W8-02, SECURITY_SUITE.md §3.2).
//
// One CycloneDX document per (repo, commit). Stored rather than regenerated
// because a dependency finding is only meaningful against the component list it
// was computed from — regenerating later gives a different tree and quietly
// re-dates every vulnerability.
export const sboms = pgTable(
  'sboms',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    commitSha: text('commit_sha').notNull(),
    format: text('format').notNull().default('cyclonedx'),
    /** The document itself. Components are queried out of it, not duplicated. */
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    componentCount: bigint('component_count', { mode: 'number' }).notNull().default(0),
    generatedBy: text('generated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sboms_workspace_repo_idx').on(t.workspaceId, t.repoId),
    unique('sboms_workspace_repo_sha_key').on(t.workspaceId, t.repoId, t.commitSha),
  ],
);

// Rule registry (W9-07, CODE_HEALTH_SUITE.md §8.1, DATABASE.md D11).
//
// PER-WORKSPACE LIFECYCLE STATE ONLY. The rule's content — its pattern, its
// message, its fixtures — lives in a versioned rulepack asset, never here: a
// rule whose text sat in a row could be edited without a review, a diff or a
// version, and the first anyone would know is a findings list that changed
// shape overnight.
export const ruleRegistry = pgTable(
  'rule_registry',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    /** '{domain}.{slug}', matching the pack asset. */
    ruleId: text('rule_id').notNull(),
    status: text('status').notNull().default('proposed'),
    /** Where it came from and under what licence — required by the validator. */
    provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull(),
    /** Set when it entered shadow, so the promotion gate can count days. */
    shadowStartedAt: timestamp('shadow_started_at', { withTimezone: true }),
    /** Last computed FP rate; NULL means nothing has been triaged. */
    fpRate: text('fp_rate'),
    /** True once trailing FP passed the demotion threshold (§8.2). */
    demotionCandidate: boolean('demotion_candidate').notNull().default(false),
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rule_registry_workspace_status_idx').on(t.workspaceId, t.status),
    unique('rule_registry_workspace_rule_key').on(t.workspaceId, t.ruleId),
    check(
      'rule_registry_status_check',
      sql`${t.status} in ('proposed', 'candidate', 'active', 'deprecated')`,
    ),
  ],
);
