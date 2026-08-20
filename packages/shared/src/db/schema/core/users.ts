// tenancy-exempt: global — a user may join many workspaces (DATABASE.md §2).
import { bigint, boolean, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  /**
   * WHO THIS PERSON IS (W15-01, D14).
   *
   * Identity is `(auth_provider, auth_subject)` — 'local' plus an email,
   * 'oidc' plus the IdP's `sub`, 'github' plus the forge user id. It is NOT the
   * forge account any more: D6 made a GitHub login the only door, which meant
   * a customer could not connect their own Gitea organisation without first
   * registering an App with a vendor they may not even use.
   */
  authProvider: text('auth_provider').notNull().default('github'),
  authSubject: text('auth_subject').notNull().default(''),
  /** Login name for display. */
  email: text('email'),
  /**
   * scrypt output for local accounts, NULL for every federated one.
   *
   * Node's built-in scrypt, deliberately: no third-party hashing dependency to
   * license or redistribute (D10/D14), no native module to build for two
   * architectures in the scan image.
   */
  passwordHash: text('password_hash'),
  /** Set when a bootstrap password must be replaced before anything else. */
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  /**
   * A LINK to a forge account, not the identity of a person.
   *
   * Nullable since W15-01: a local or OIDC user has none until they claim one,
   * and personalized views say so rather than rendering an empty list as if it
   * were a real answer.
   */
  forgeUserId: text('forge_user_id').unique(),
  login: text('login').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  // W4-10 (UX_SPEC §6, D9/R-A2). NULL means "not asked yet", which is what
  // triggers the picker — distinct from any persona value, so a user who picks
  // one is never asked again and a user who somehow clears it is.
  persona: text('persona'),
  // Per-user preferences (onboarding checklist dismissal today). Deliberately
  // on `users` and not `workspaces.settings`: the checklist has a member
  // variant, and workspace-scoped state would let one member's dismissal hide
  // it for everyone. R-A1's "no new tables" is honoured — this is a column.
  prefs: jsonb('prefs').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per person per provider. Two IdPs may legitimately issue the same
    // `sub`, so the provider is part of the key rather than trusting the
    // subject to be globally unique.
    unique('users_auth_provider_subject_key').on(t.authProvider, t.authSubject),
  ],
);
