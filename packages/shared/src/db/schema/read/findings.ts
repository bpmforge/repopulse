import {
  bigint,
  boolean,
  check,
  jsonb,
  index,
  numeric,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { users } from '../core/users.js';
import { pullRequests } from '../facts/pull-requests.js';
import { analysisRuns } from './analysis-runs.js';
import { scanRuns } from '../security/index.js';

// Base shape only (ANALYSIS_TIERS.md §4/§5) — the W8/D9/D10/D11/D12/D13
// delta columns (scanner_key, verify_status, risk_factors, reachability,
// experimental, etc.) are later-wave additive migrations, not part of
// W1-02. file/line_start/line_end are NOT NULL here; the W8 migration
// makes them nullable for repo-level scanner findings (DATABASE.md §2).
export const findings = pgTable(
  'findings',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    // NULLABLE since W8-04: a scanner run is not an analysis run. W8-02
    // attached scanner findings to a dummy tier-2 analysis_runs row to satisfy
    // this FK, which made every scanner finding claim an LLM tier it never
    // used. scan_run_id is the real parent; the check below requires exactly
    // one of the two, so a finding always has a run that explains it.
    analysisRunId: bigint('analysis_run_id', { mode: 'number' }).references(() => analysisRuns.id),
    pullRequestId: bigint('pull_request_id', { mode: 'number' }).references(() => pullRequests.id),
    dimension: text('dimension').notNull(),
    // 1-5, 5=critical ... 1=info (ANALYSIS_TIERS.md §4 canonical numeric scale).
    severity: smallint('severity').notNull(),
    confidence: smallint('confidence').notNull(),
    title: text('title').notNull(),
    // NULLABLE since W8-02: a dependency CVE or an IaC misconfiguration is a
    // REPO-level fact with no line to point at. Forcing a line would mean
    // inventing one, and an invented location in a security finding sends
    // someone to the wrong place with confidence.
    file: text('file'),
    lineStart: integer('line_start'),
    lineEnd: integer('line_end'),
    evidence: text('evidence').notNull(),
    recommendation: text('recommendation').notNull(),
    tier: smallint('tier').notNull(),
    // sha256(dimension + '\0' + file + '\0' + normalize(evidence_quote)) +
    // line-bucket tiebreak (ANALYSIS_TIERS.md §5).
    dedupKey: text('dedup_key').notNull(),
    status: text('status').notNull(),
    dismissReason: text('dismiss_reason'),
    statusChangedBy: bigint('status_changed_by', { mode: 'number' }).references(() => users.id),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    /**
     * W6-05 (FR-ANALYSIS-9). 'unverified' is the honest default: a finding
     * nobody has re-judged is not the same as one a second model confirmed,
     * and collapsing the two would let an unchecked claim wear the badge of a
     * verified one.
     */
    verifyStatus: text('verify_status').notNull().default('unverified'),
    // W8-02 scanner delta (§1.3). All nullable: an analysis finding has none of
    // them, and a NOT NULL default would make every LLM finding claim a rule id
    // it does not have.
    scannerKey: text('scanner_key'),
    ruleId: text('rule_id'),
    cveId: text('cve_id'),
    chainId: text('chain_id'),
    /** What must already be true for this finding to be exploitable (chainer input). */
    preconditions: jsonb('preconditions').$type<Record<string, unknown>>(),
    /** What an attacker gains from it — matched against another finding's preconditions. */
    yields: jsonb('yields').$type<Record<string, unknown>>(),
    scanRunId: bigint('scan_run_id', { mode: 'number' }).references(() => scanRuns.id),
    /**
     * W9-07 shadow mode (§8.2). True when the rule that produced this finding
     * is a CANDIDATE: the finding is real and triageable, and is excluded from
     * health scores, org banners, plan generation and reports. Default false,
     * because a finding from a live rule counts — and a nullable flag would
     * make "unknown" a third state nobody would handle.
     */
    experimental: boolean('experimental').notNull().default(false),
    /**
     * W9-09 risk pricing (RISK_MODEL.md §2, DATABASE.md D12).
     *
     * effective_risk is 100·H·L·X. The DECOMPOSITION is stored beside it, not
     * derived on read: the number decides what a team works on next, and a
     * score whose inputs are gone cannot be argued with — only obeyed.
     */
    effectiveRisk: numeric('effective_risk', { precision: 6, scale: 2 }),
    riskFactors: jsonb('risk_factors').$type<Record<string, unknown>>(),
    riskBand: text('risk_band'),
  },
  (t) => [
    unique('findings_workspace_repo_dedup_key').on(t.workspaceId, t.repoId, t.dedupKey),
    // W9-09 (DATABASE.md D12): every risk surface sorts by effective_risk
    // within a workspace/repo/status scope, and that is the whole index.
    index('findings_workspace_repo_risk_idx').on(
      t.workspaceId,
      t.repoId,
      t.status,
      t.effectiveRisk.desc(),
    ),
    // Findings filters (DATABASE.md §3 hot-path index)
    index('findings_workspace_repo_dimension_severity_status_idx').on(
      t.workspaceId,
      t.repoId,
      t.dimension,
      t.severity,
      t.status,
    ),
    check(
      'findings_dimension_check',
      // W8-02 (§1.3): the scanner dimensions join the four analysis ones in
      // ONE store. A separate scanner_findings table was the alternative and
      // would have doubled every query, every facet and every report section —
      // and made "all findings for this file" a union nobody remembers to write.
      // W10 (D13, FR-REG-1..6) adds the four STRUCTURAL registers. They are
      // not security findings and not code-health findings: a module with one
      // maintainer is a fact about a team, an abandoned dependency is a fact
      // about the ecosystem, and both need their own facet rather than being
      // filed under something they are not.
      //
      // 'logging' joins them in W9-04 (FR-CH-4): a missing or dangerous log
      // line is neither a security finding nor general code health — it is the
      // thing that makes an incident unreconstructable, and it gets filtered
      // for on its own.
      //
      // 'compound' joins them in W8-09: a file flagged by three different
      // scanners is a finding in its own right (FR-INSIGHTS-6, D9), and it is
      // not a chain — a chain is a path, this is a concentration.
      sql`${t.dimension} in ('code_health', 'security', 'performance', 'test_coverage', 'secrets', 'dependency', 'sast', 'iac', 'chain', 'compound', 'logging', 'knowledge', 'dependency_health', 'architecture', 'test_gap')`,
    ),
    check('findings_severity_check', sql`${t.severity} between 1 and 5`),
    check('findings_confidence_check', sql`${t.confidence} between 1 and 5`),
    check(
      'findings_verify_status_check',
      sql`${t.verifyStatus} in ('unverified', 'confirmed', 'contradicted')`,
    ),
    check(
      // W8-04: every finding has exactly one parent run. Without this, dropping
      // the NOT NULL above would allow an orphan finding that no run explains —
      // and "which scan found this, with which rulepack version" is the first
      // question anyone asks of a security finding.
      'findings_run_parent_check',
      sql`(${t.analysisRunId} is not null) <> (${t.scanRunId} is not null)`,
    ),
    check(
      'findings_status_check',
      sql`${t.status} in ('open', 'confirmed', 'dismissed', 'resolved', 'wont_fix')`,
    ),
  ],
);
