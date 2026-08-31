import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
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
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('repo_scanner_config_workspace_repo_idx').on(t.workspaceId, t.repoId),
    unique('repo_scanner_config_workspace_repo_scanner_key').on(
      t.workspaceId,
      t.repoId,
      t.scannerKey,
    ),
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
    /**
     * The CVE validation funnel this run measured (W8-13/W8-14, FR-SEC-15).
     *
     * NULLABLE, AND THE NULL IS LOAD-BEARING. `raw` is grype's pre-dedup match
     * count: it exists for the length of one scan and is unrecoverable from the
     * findings rows afterwards, because de-duplication is exactly what the
     * findings table stores the far side of. Without this column the honesty
     * rule — "the raw count is never hidden" — could only be met by printing a
     * zero, and a zero here would say "no advisories" when it means "nobody
     * wrote the number down". So a run that predates this column reads as
     * unrecorded and the UI says so.
     *
     * Only the dependency scanner writes it; other scanners have no funnel.
     */
    validationFunnel: jsonb('validation_funnel').$type<Record<string, unknown>>(),
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

// VEX statements (W8-14, DATABASE.md, SECURITY_SUITE.md §3.6, FR-SEC-14).
//
// The audit trail behind every suppressed dependency finding. A dismissal that
// is only a status column is indistinguishable from a bug nobody looked at, so
// each one is a ROW HERE: who said it, which versions they examined, and — for
// not_affected — a justification from the OpenVEX enum, which is a claim a
// reader is able to disagree with.
//
// `under_investigation` IS NOT WRITTEN HERE. Untriaged is the absence of a
// covering row, computed at read time, which is why a re-scan at a covered
// version creates zero new rows and a version outside the range reopens
// automatically: both are branches of one lookup rather than state anybody has
// to keep in step.
export const vexStatements = pgTable(
  'vex_statements',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    /**
     * VERSIONLESS purl — `pkg:npm/jquery`, never `pkg:npm/jquery@3.4.1`.
     *
     * The version belongs in `version_range`, which is the field a reader
     * interrogates. Carrying it in both would let the two disagree, and the
     * unique key below would stop being the identity of a decision.
     */
    packagePurl: text('package_purl').notNull(),
    /** Canonical id — CVE where one exists, otherwise GHSA/OSV as reported. */
    vulnId: text('vuln_id').notNull(),
    /** The grammar lives in packages/security/src/vex/range.ts. '*' = all. */
    versionRange: text('version_range').notNull(),
    status: text('status').notNull(),
    justification: text('justification'),
    /** Free prose. Never a substitute for the justification — see the CHECK. */
    statusNotes: text('status_notes'),
    /** Reachability tier, import refs, finding id: what the author was shown. */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
    authorUserId: bigint('author_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vex_statements_workspace_repo_idx').on(t.workspaceId, t.repoId),
    // The scan-time suppression lookup: every statement for a repository, then
    // matched in memory against the observed purls. Keyed this way rather than
    // per-purl because a scan asks about every package at once.
    index('vex_statements_lookup_idx').on(t.workspaceId, t.repoId, t.vulnId),
    unique('vex_statements_identity_key').on(
      t.workspaceId,
      t.repoId,
      t.packagePurl,
      t.vulnId,
      t.versionRange,
    ),
    // A DOCUMENTED NARROWING of DATABASE.md's four-value enum:
    // 'under_investigation' is deliberately absent, because it is the computed
    // meaning of having no row and a stored one would be a second source of
    // truth for the same fact. The constraint is what keeps that invariant from
    // eroding the first time someone writes an insert by hand.
    check('vex_statements_status_check', sql`${t.status} in ('not_affected', 'affected', 'fixed')`),
    check(
      'vex_statements_justification_enum_check',
      sql`${t.justification} is null or ${t.justification} in ('component_not_present', 'vulnerable_code_not_present', 'vulnerable_code_not_in_execute_path', 'vulnerable_code_cannot_be_controlled_by_adversary', 'inline_mitigations_already_exist')`,
    ),
    // THE GATE, IN THE DATABASE AND NOT ONLY IN THE ROUTE. The API returns 400
    // for a not_affected without a justification, but a route check only binds
    // the writer that runs it; a migration, a fixture loader or tomorrow's
    // second endpoint would all be free to insert an unjustified dismissal.
    // "We looked and it does not apply" must carry a reason wherever the row
    // comes from.
    check(
      'vex_statements_justification_required_check',
      sql`${t.status} <> 'not_affected' or ${t.justification} is not null`,
    ),
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
    updatedBy: bigint('updated_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
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

// Nightly db-sync tables (W10-02, DATABASE.md D13 delta, FR-REG-2/3).
//
// These exist so the SCAN SANDBOX never needs a network. The registers run
// against rows, the sync job runs in the worker, and the `--network=none`
// container keeps knowing nothing about the internet. Neither table is
// workspace-scoped: "when was express last released" is a fact about the
// world, identical for every tenant, and copying it per workspace would give
// two tenants different answers to the same question depending on when each
// one last synced.
export const releaseMeta = pgTable(
  'release_meta',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** 'npm' | 'pypi' — the ecosystems whose registries we read today. */
    ecosystem: text('ecosystem').notNull(),
    package: text('package').notNull(),
    latestVersion: text('latest_version'),
    latestReleaseAt: timestamp('latest_release_at', { withTimezone: true }),
    deprecated: boolean('deprecated').notNull().default(false),
    /**
     * NULL, not false, where the ecosystem has no such concept.
     *
     * npm has no yank: a package is unpublished and disappears entirely, so
     * `false` there would be a claim we cannot make. PyPI does have yanking
     * (PEP 592) and sets a real boolean.
     */
    yanked: boolean('yanked'),
    /** SPDX-ish string as the registry reports it; unparsed on purpose. */
    license: text('license'),
    /**
     * version -> ISO release date, for the versions we have been asked about.
     *
     * A DOCUMENTED DELTA from the D13 column list, and the reason is the
     * definition of libyear: it is the age gap between the version you have
     * installed and the newest one, so it needs the INSTALLED version's
     * release date, which no column in D13 holds. Without this the register
     * could only report "the latest release is old", which is abandonment —
     * a different signal wearing libyear's name.
     */
    versionDates: jsonb('version_dates').$type<Record<string, string>>().notNull().default({}),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('release_meta_ecosystem_package_key').on(t.ecosystem, t.package),
    check('release_meta_ecosystem_check', sql`${t.ecosystem} in ('npm', 'pypi')`),
  ],
);

export const eolProducts = pgTable(
  'eol_products',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** endoflife.date product name, e.g. 'nodejs', 'python', 'debian'. */
    product: text('product').notNull(),
    /** Release cycle as the source names it: '22', '3.11', 'bookworm'. */
    cycle: text('cycle').notNull(),
    eolDate: timestamp('eol_date', { withTimezone: true }),
    supportUntil: timestamp('support_until', { withTimezone: true }),
    latestVersion: text('latest_version'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('eol_products_product_cycle_key').on(t.product, t.cycle)],
);
