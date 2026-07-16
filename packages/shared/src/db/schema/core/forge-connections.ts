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
    // Nullable: only set once the webhook is registered post-connection —
    // DATABASE.md doesn't mark this explicitly, but a PAT-only connection or
    // a connection mid-setup has no webhook secret yet.
    webhookSecretCiphertext: bytea('webhook_secret_ciphertext'),
    // No enum values enumerated in DATABASE.md for this field (unlike
    // repos.sync_status) — left as plain text, not CHECK-constrained.
    status: text('status').notNull(),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('forge_connections_workspace_id_idx').on(t.workspaceId),
    check('forge_connections_provider_check', sql`${t.provider} in ('github', 'gitea')`),
    check('forge_connections_auth_kind_check', sql`${t.authKind} in ('pat', 'app')`),
  ],
);
