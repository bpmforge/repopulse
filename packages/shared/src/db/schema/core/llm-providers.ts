import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  bigint,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { workspaces } from './workspaces.js';
import { users } from './users.js';
import { bytea } from './custom-types.js';

// LLM provider connections (W16-06, D-LLM-1).
//
// RepoPulse is a standalone product and the person installing it brings their
// own model — local or hosted. Until this table, that was not something the
// product could express: Tier 2 was an `LMSTUDIO_BASE_URLS` environment
// variable, Tier 3 was `ANTHROPIC_API_KEY`, and neither had a configuration
// surface at all. Changing model or vendor meant editing a file on the host and
// restarting the container.
//
// SHAPED AFTER `forge_connections`, deliberately — same workspace scoping, same
// encrypted-credential columns, same "text + CHECK rather than a pg enum for a
// list that will grow" rule (DATABASE.md §5). A reader who understands how a
// forge connection is stored already understands this one.
//
// The CONNECTION MODEL follows what OpenCode does, without using its code: a
// provider is an id, an adapter kind, an options bag (base URL, credential,
// extra headers) and a model. That shape is what makes one row able to describe
// Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, Groq, Together, Fireworks,
// DeepSeek and OpenAI itself, because all of them speak the same
// `/v1/chat/completions` wire format that packages/analysis already speaks.
//
// Auth comes in three classes and only the first is implemented here (W16-09
// adds the rest), which is why `kind` and not a boolean: an unsupported class
// must fail at CONFIGURATION time with a clear message, not at call time.
//
//   api key            openai_compatible, anthropic     — this ticket
//   cloud credentials  vertex, bedrock                  — W16-09
//   oauth device flow  copilot, openai_subscription     — W16-09

/** Provider kinds. Ordered by auth class; see the note above. */
export const LLM_PROVIDER_KINDS = [
  'openai_compatible',
  'anthropic',
  'gemini',
  'vertex',
  'bedrock',
  'copilot',
  'openai_subscription',
  // W19-08: the customer's own Claude Code CLI. Off until an admin accepts the
  // responsibility statement (llm_responsibility_acceptances).
  'claude_cli',
] as const;

export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

/** Renders the kind list for a CHECK constraint, so the two cannot drift. */
export function llmProviderKindSqlList(): string {
  return LLM_PROVIDER_KINDS.map((k) => `'${k}'`).join(', ');
}

export const llmProviders = pgTable(
  'llm_providers',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    /** The operator's own label — "Workstation Ollama", not "provider 3". */
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    /**
     * Origin or /v1 URL. NULL only for kinds whose endpoint is fixed by the
     * vendor (anthropic), so a row cannot claim to be an OpenAI-compatible
     * provider while naming no endpoint — enforced by the CHECK below rather
     * than by whichever code path happens to read it first.
     */
    baseUrl: text('base_url'),
    /**
     * The model id to request. No default, ever: the Tier-2 client shipped with
     * `'default'` once and LM Studio answered `Invalid model identifier` on
     * every call. A guessed model name is a guess about someone else's machine.
     */
    model: text('model').notNull(),
    // AES-256-GCM through the same vault as forge tokens (Law 9, FR-AUTH-5).
    // NULLABLE, because a LAN model legitimately has no credential and
    // requiring one would make the local case the awkward one.
    credentialCiphertext: bytea('credential_ciphertext'),
    credentialIv: bytea('credential_iv'),
    keyVersion: integer('key_version'),
    /** Shown instead of the key, the way a forge token's last4 is. */
    credentialFingerprint: text('credential_fingerprint'),
    /**
     * Extra headers, verbatim (OpenRouter's attribution headers, a gateway's
     * routing headers, Helicone's cache flags). Values are NOT secrets — a
     * credential belongs in the encrypted columns above, and the API refuses a
     * header that looks like one.
     */
    headers: jsonb('headers').$type<Record<string, string>>(),
    /**
     * SC-24 opt-out, per row and per human.
     *
     * The host policy in packages/analysis rejects anything that is not a
     * private-range LAN address, because Tier 2 sends DIFFS — the most
     * sensitive thing the warehouse holds — and a request-supplied host would
     * let anyone who can reach the analysis API redirect them. That default is
     * unchanged. This column is the deliberate, reviewable exception a person
     * makes when they genuinely mean "send this to OpenAI", and it is why the
     * exception is a stored decision with an author rather than a config flag.
     */
    allowPublicHost: boolean('allow_public_host').notNull().default(false),
    /**
     * Result of the capability probe (W19-01): context window, streaming,
     * JSON mode, tool use, and the sentences explaining non-obvious results.
     * NULL until probed. Holds no secret — it is what the model said about
     * itself — so it is returned to the admin UI as stored.
     */
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>(),
    probedAt: timestamp('probed_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    // SET NULL (W16-59): a configured model outlives whoever added it.
    createdBy: bigint('created_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('llm_providers_workspace_id_idx').on(t.workspaceId),
    // A label is how an operator tells two providers apart in the UI and in an
    // egress audit row; two rows with the same name make both useless.
    unique('llm_providers_workspace_name_key').on(t.workspaceId, t.name),
    check('llm_providers_kind_check', sql.raw(`kind in (${llmProviderKindSqlList()})`)),
    // An OpenAI-compatible provider with no endpoint is not a provider, it is a
    // row that will fail on its first call with a confusing error. Vendors with
    // a fixed endpoint may omit it.
    check(
      'llm_providers_base_url_check',
      sql.raw(
        `base_url is not null or kind in ('anthropic', 'gemini', 'bedrock', 'copilot', 'openai_subscription', 'claude_cli')`,
      ),
    ),
    // The encrypted-credential columns move together or not at all. A row with
    // ciphertext and no IV is undecryptable, and it would be discovered on the
    // call that needed it rather than on the write that broke it.
    check(
      'llm_providers_credential_check',
      sql.raw(
        `(credential_ciphertext is null and credential_iv is null and key_version is null and credential_fingerprint is null)` +
          ` or (credential_ciphertext is not null and credential_iv is not null and key_version is not null and credential_fingerprint is not null)`,
      ),
    ),
  ],
);

// Per-role model routing (W19-02).
//
// A workspace maps each ROLE to an ordered chain of (connection, model). One
// row per link, ordered by `position`; the gateway falls back along the chain
// on provider errors only. Role names are the ones in
// docs/design/ATTEST_EXPERTS.md. Keep this list equal to LLM_ROLES in
// packages/analysis/src/routing (a test in apps/api asserts they match — the
// shared package cannot import the analysis package).
export const LLM_ROLES = [
  'security',
  'performance',
  'code_health',
  'best_practices',
  'ai_slop',
  'test_coverage',
  'triage',
  'patch',
] as const;

export const llmRoleRoutes = pgTable(
  'llm_role_routes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    role: text('role').notNull(),
    /** 0 is the first choice. */
    position: integer('position').notNull(),
    // CASCADE: a deleted connection leaves the chain, it does not leave a
    // dangling link that fails on the next scheduled pass.
    providerId: bigint('provider_id', { mode: 'number' })
      .notNull()
      .references(() => llmProviders.id, { onDelete: 'cascade' }),
    /** Overrides the connection's own model for this role. NULL = use it. */
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('llm_role_routes_workspace_id_idx').on(t.workspaceId),
    unique('llm_role_routes_workspace_role_position_key').on(t.workspaceId, t.role, t.position),
    check(
      'llm_role_routes_role_check',
      sql.raw(`role in (${LLM_ROLES.map((r) => `'${r}'`).join(', ')})`),
    ),
    check('llm_role_routes_position_check', sql.raw('position >= 0')),
  ],
);

/** One row per workspace; absent means the defaults (local-only off). */
export const llmRoutingPolicy = pgTable('llm_routing_policy', {
  workspaceId: bigint('workspace_id', { mode: 'number' })
    .primaryKey()
    .references(() => workspaces.id),
  /** Refuse any role whose chain would leave the operator's network. */
  localOnly: boolean('local_only').notNull().default(false),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Responsibility acceptances (W19-08).
//
// Some options are off until an admin reads a statement and accepts it. The
// acceptance is a ROW, not a flag: who, when, which topic, which VERSION of the
// statement and its SHA-256, so what was agreed to is provable later. Rows are
// never deleted; revoking sets `revoked_at` / `revoked_by`. At most one ACTIVE
// (not revoked) acceptance per workspace and topic.
export const llmResponsibilityAcceptances = pgTable(
  'llm_responsibility_acceptances',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    workspaceId: bigint('workspace_id', { mode: 'number' })
      .notNull()
      .references(() => workspaces.id),
    /** What was accepted. Today only 'claude_cli'. */
    topic: text('topic').notNull(),
    statementVersion: text('statement_version').notNull(),
    statementSha256: text('statement_sha256').notNull(),
    acceptedBy: bigint('accepted_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedBy: bigint('revoked_by', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('llm_responsibility_acceptances_workspace_idx').on(t.workspaceId),
    uniqueIndex('llm_responsibility_acceptances_active_key')
      .on(t.workspaceId, t.topic)
      .where(sql`revoked_at is null`),
    check('llm_responsibility_acceptances_topic_check', sql.raw(`topic in ('claude_cli')`)),
    // A revoke records who, and a row with a revoker has a revoke time.
    check(
      'llm_responsibility_acceptances_revoke_check',
      sql.raw(`(revoked_at is null and revoked_by is null) or revoked_at is not null`),
    ),
  ],
);
