import { bigint, check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces.js';
import { users } from './users.js';

// Customer-CI read tokens (W18-18, FOUNDING_BRIEF D16 "CI pull").
//
// The customer's own CI asks RepoPulse "what is new on this PR?" and then
// fails its own build or posts its own comment with ITS OWN forge token.
// RepoPulse never writes to a repository (D9a), so this credential is the
// only thing the CI pull model adds, and it must be unable to do anything but
// read PR findings for the repositories it names.
//
// NOT A FORGE CREDENTIAL, and stored differently on purpose. A forge token is
// something RepoPulse must USE, so it is encrypted and decrypted (SC-1). This
// token is something RepoPulse only has to RECOGNISE, so only a SHA-256 of it
// is kept: a database dump or a backup reveals nothing that can call the API.
// A plain hash rather than a slow KDF because the secret is 256 random bits —
// there is no dictionary to slow down, and lookup must be by equality on an
// indexed column, which a salted KDF cannot offer.

/** The scopes a CI token can carry. Read-only by construction: there is no write scope to add. */
export const CI_TOKEN_SCOPES = ['pr_findings:read'] as const;
export type CiTokenScope = (typeof CI_TOKEN_SCOPES)[number];

export const ciTokens = pgTable(
  'ci_tokens',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    /** The operator's label — "payments-api GitHub Actions", not "token 3". */
    name: text('name').notNull(),
    /** hex(sha256(token)). The token itself is shown once at creation and never stored. */
    tokenHash: text('token_hash').notNull(),
    /**
     * The first characters of the token, for recognising which one a CI secret
     * holds. Short enough to be useless to an attacker (the random part is 43
     * characters; this keeps 8 of them).
     */
    tokenPrefix: text('token_prefix').notNull(),
    scope: text('scope').notNull().default('pr_findings:read'),
    /**
     * The repositories this token may read. An array rather than a join table:
     * it is written once at creation, never edited (a different repo set is a
     * different token), and read on every request — one row, no join.
     */
    repoIds: bigint('repo_ids', { mode: 'number' }).array().notNull(),
    createdBy: bigint('created_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Denormalised like finding_events.actor_login (W16-59): the author survives their account. */
    createdByLogin: text('created_by_login'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Revoked rows are kept, not deleted: "which token read this, and who killed it" outlives it. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: bigint('revoked_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    unique('ci_tokens_token_hash_key').on(t.tokenHash),
    index('ci_tokens_workspace_idx').on(t.workspaceId),
    check(
      'ci_tokens_scope_check',
      sql`${t.scope} in (${sql.raw(CI_TOKEN_SCOPES.map((s) => `'${s}'`).join(', '))})`,
    ),
    // A token naming no repository could read nothing, and an empty list is
    // too easy to mistake for "all repositories" in some later reader.
    check('ci_tokens_repo_ids_nonempty_check', sql`cardinality(${t.repoIds}) > 0`),
  ],
);
