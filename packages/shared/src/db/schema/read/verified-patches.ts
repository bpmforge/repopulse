import {
  bigint,
  check,
  index,
  integer,
  jsonb,
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
import { findings } from './findings.js';

// Verified patches (W18-19, D16 "Verified + CI pull").
//
// A model-drafted fix for one finding, applied to the scanned snapshot inside
// the sandbox flow and re-scanned. Only `verified` rows are ever shown to a
// developer; a `rejected` row keeps its reason for an admin and shows nothing
// else. Nothing here is ever written to the forge (D9a): the diff is handed to
// a person, who applies it themselves.
//
// ONE ROW PER FINDING PER SNAPSHOT. Idempotency is the unique key on
// (workspace, finding, commit_sha): asking twice for the same finding at the
// same commit returns the first answer rather than spending a second model
// call, and a new scan at a new commit is a new question.
//
// `failed` is distinct from `rejected` on purpose. Rejected means a patch was
// drafted and the rules said no — a verdict about the patch. Failed means the
// attempt could not be made (no model configured, the sandbox was down) — a
// fact about the deployment, and the one state a retry may overwrite.
export const verifiedPatches = pgTable(
  'verified_patches',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    repoId: bigint('repo_id', { mode: 'number' })
      .notNull()
      .references(() => repos.id),
    findingId: bigint('finding_id', { mode: 'number' })
      .notNull()
      .references(() => findings.id, { onDelete: 'cascade' }),
    /** The scan's commit — the snapshot the patch was applied to and re-scanned at. */
    commitSha: text('commit_sha').notNull(),
    /** The target finding's dedup key at request time; the verifier looks for exactly this. */
    targetDedupKey: text('target_dedup_key').notNull(),
    status: text('status').notNull().default('pending'),
    /** Machine-readable verdict code (verify.ts VerdictCode, or a diff-shape code). */
    reasonCode: text('reason_code'),
    /** Admin-visible reason. Never shown to a non-admin for a rejected patch. */
    reason: text('reason'),
    /**
     * The canonical diff that was applied (real line numbers, correct counts).
     * For a patch rejected at the shape gate it is the model's text, capped,
     * kept for the admin reading why — never served to a developer.
     */
    diff: text('diff'),
    /** 2 or 3. What was ASKED for; the gateway refuses Tier-3 without the repo opt-in. */
    tier: smallint('tier').notNull().default(2),
    /** The model id the gateway reported for the call that drafted it. */
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /**
     * One entry per rule-set execution (runner, before|after, status, hit count,
     * tool versions, a run id). Kept here rather than as scan_runs rows: those
     * drive "when did this scanner last run on this repo", and a one-file
     * verification run must not read as the repository's last full scan.
     */
    verificationRuns: jsonb('verification_runs').$type<Record<string, unknown>[]>(),
    requestedBy: bigint('requested_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    unique('verified_patches_workspace_finding_commit_key').on(
      t.workspaceId,
      t.findingId,
      t.commitSha,
    ),
    // The daily drafting cap counts a workspace's requests by time.
    index('verified_patches_workspace_created_idx').on(t.workspaceId, t.createdAt),
    check(
      'verified_patches_status_check',
      sql`${t.status} in ('pending', 'verified', 'rejected', 'failed')`,
    ),
    check('verified_patches_tier_check', sql`${t.tier} in (2, 3)`),
  ],
);
