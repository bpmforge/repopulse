import { bigint, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces.js';
import { users } from './users.js';
import { bytea } from './custom-types.js';

export const forgeConnections = pgTable(
  'forge_connections',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    // DATABASE.md §5: text + CHECK, not a pg enum (likely to grow).
    provider: text('provider').notNull(),
    authKind: text('auth_kind').notNull(),
    // AES-256-GCM; plaintext never in DB/logs (FR-AUTH-5, NFR-6). Decryption
    // only inside packages/forge memory.
    credentialCiphertext: bytea('credential_ciphertext').notNull(),
    credentialIv: bytea('credential_iv').notNull(),
    keyVersion: integer('key_version').notNull(),
    credentialFingerprint: text('credential_fingerprint').notNull(),
    appInstallationId: text('app_installation_id'),
    /**
     * This connection's forge base URL (W14-02).
     *
     * NULL means "whatever FORGE_BASE_URL said when this connection was made",
     * and the resolver backfills it the first time it loads such a row — so an
     * existing install keeps working, and an operator who later re-points
     * FORGE_BASE_URL does not silently move connections that were created
     * against a different host.
     *
     * One deployment can now serve two forges: a self-hosted Gitea and
     * github.com in the same workspace, which a server-level env could not
     * express at all.
     */
    baseUrl: text('base_url'),
    // Nullable: only set once the webhook is registered post-connection —
    // DATABASE.md doesn't mark this explicitly, but a PAT-only connection or
    // a connection mid-setup has no webhook secret yet.
    webhookSecretCiphertext: bytea('webhook_secret_ciphertext'),
    // No enum values enumerated in DATABASE.md for this field (unlike
    // repos.sync_status) — left as plain text, not CHECK-constrained.
    status: text('status').notNull(),
    // SET NULL, emphatically NOT cascade (W16-59): cascading here would take
    // `repos` and the entire warehouse with it. A connection is shared
    // infrastructure that outlives whoever pasted the token.
    createdBy: bigint('created_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * W20-25 (UX_TODO ADM-50): the forge account the token belongs to and when
     * it stops working, read from the forge at connect time (and once by the
     * nightly sweep for a connection made before this). Never the token. Null
     * where the forge does not say: an App installation, a token that never
     * expires, a Gitea token. token_checked_at is null until the read worked.
     */
    tokenOwnerLogin: text('token_owner_login'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    tokenCheckedAt: timestamp('token_checked_at', { withTimezone: true }),
  },
  (t) => [
    index('forge_connections_workspace_id_idx').on(t.workspaceId),
    check('forge_connections_provider_check', sql`${t.provider} in ('github', 'gitea', 'gitlab')`),
    check('forge_connections_auth_kind_check', sql`${t.authKind} in ('pat', 'app')`),
  ],
);
