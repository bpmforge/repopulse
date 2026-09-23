import { bigint, index, integer, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from '../core/workspaces.js';
import { repos } from '../core/repos.js';
import { users } from '../core/users.js';
import { pullRequests } from '../facts/pull-requests.js';
import { analysisRuns } from './analysis-runs.js';

// Append-only (NFR-9). No content stored — digest only. Admin-queryable, never
// deleted. SC-15: INSERT-only grant for the app DB role applied in migration
// 0002 (drizzle can't generate GRANT/CREATE ROLE from schema — see
// packages/shared/drizzle/0002_egress_audit_grants.sql).
//
// W17-11 WIDENED THIS, and the reasons matter:
//
// 1. NO LONGER TIER-3 ONLY. The table was written for Tier-3, the only path
//    that was ever going to leave the network. But a Tier-2 provider row can
//    name a PUBLIC host — an OpenAI-compatible cloud endpoint is configured
//    exactly like a LAN LM Studio — and those calls were sending diffs
//    off-network with no record at all. What makes a call auditable is where it
//    goes, not which tier it is labelled.
//
// 2. AN ATTEMPT IS NOT AN OUTCOME. The row was written once, after a successful
//    call, with token counts. That cannot express "we tried and it timed out",
//    which is the case an auditor most needs: the bytes left this network
//    whether or not the answer came back. So a call now writes an `attempted`
//    row BEFORE dispatch and appends an outcome row afterwards, both carrying
//    the same `attempt_id`.
//
// 3. THE ROWS CANNOT BE UPDATED. SC-15 grants INSERT and SELECT only, so the
//    outcome genuinely has to be a second row — an UPDATE would be refused by
//    the database, which is the protection working.
//
// 4. UNKNOWN IS NOT ZERO. tokens_sent/tokens_received were NOT NULL, so a
//    provider that reports no usage had to be recorded as having used none.
//    They are nullable now: null means "not measured", 0 means "measured, and
//    it was zero", and an audit that cannot tell those apart is not an audit.
export const egressAudit = pgTable(
  'egress_audit',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    pullRequestId: bigint('pull_request_id', { mode: 'number' }).references(() => pullRequests.id),
    /**
     * Nullable since W17-11: a gateway call is audited at the network boundary,
     * which is upstream of whatever analysis run may or may not own it. Refusing
     * to audit a call because no run row exists yet would be exactly backwards.
     */
    analysisRunId: bigint('analysis_run_id', { mode: 'number' }).references(() => analysisRuns.id),
    // The audit row is the point (W16-59). SET NULL on its own would leave a
    // record that code left the network and NOT who sent it — the single field
    // this table exists to hold. The login is denormalised beside the id, so
    // deleting an account cannot erase the fact that they sent it.
    initiatorUserId: bigint('initiator_user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    initiatorLogin: text('initiator_login'),
    modelId: text('model_id').notNull(),
    bytesSent: integer('bytes_sent').notNull(),
    /** NULL means not measured. 0 means measured as zero. See note 4 above. */
    tokensSent: integer('tokens_sent'),
    /** NULL means not measured. 0 means measured as zero. */
    tokensReceived: integer('tokens_received'),
    contentSha256: text('content_sha256').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),

    // ---- W17-11 additions ----------------------------------------------
    /**
     * One id per NETWORK ATTEMPT, shared by that attempt's `attempted` row and
     * its outcome row.
     *
     * Per attempt, not per call: a retry is a second attempt that genuinely
     * sent the bytes again, and collapsing retries would under-report egress.
     * But a persistence retry of the SAME attempt reuses the id, so a flaky
     * database write cannot inflate the count.
     */
    attemptId: text('attempt_id'),
    /**
     * `attempted` written before dispatch; then exactly one of `succeeded`,
     * `failed`, or `denied`. `denied` means policy refused it and NOTHING was
     * sent — recorded because a blocked attempt is something an auditor wants
     * to see, and its bytes_sent is 0 for the same reason.
     */
    outcome: text('outcome'),
    /** The host the bytes were addressed to. The whole question, in one column. */
    destinationHost: text('destination_host'),
    /** 2 or 3. Kept because the tiers have different approval rules. */
    tier: smallint('tier'),
    /** Failure detail. Never contains request content. */
    error: text('error'),
  },
  (t) => [
    index('egress_audit_workspace_id_idx').on(t.workspaceId),
    index('egress_audit_attempt_id_idx').on(t.attemptId),
  ],
);
