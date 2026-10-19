import { and, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';

// The identity seam (W15-01, D14).
//
// EVERY way of signing in ends here, and this is the only place that turns an
// authenticated subject into a user row. Before this, GitHub OAuth WAS the
// mechanism: `findOrCreateUser` took a GitHub identity and upserted on
// `forge_user_id`, so the forge account and the person were the same record and
// there was no seam to add a second provider at.
//
// The consequence was not theoretical. A customer could not connect their own
// Gitea organisation without first registering a GitHub App, because the
// Connections screen sits behind GitHub sign-in — a product whose first setup
// step needs a third party's approval cannot be bootstrapped by the person who
// bought it.
//
// WHAT A PROVIDER MUST SUPPLY is deliberately tiny: who this is, stably. Not a
// token, not a session, not a role. Anything a provider knows beyond that is
// its own business, which is what keeps a new provider a leaf rather than a
// change to this file.

export type AuthProviderId = 'local' | 'oidc' | 'github';

export interface AuthenticatedSubject {
  provider: AuthProviderId;
  /**
   * Stable, opaque, and unique WITHIN the provider — an OIDC `sub`, a forge
   * user id, a local account's email. Two IdPs may issue the same `sub`, which
   * is why the provider is half of the key and this is never trusted alone.
   */
  subject: string;
  /** Display name for the UI. Never used for identity. */
  login: string;
  email?: string | undefined;
  name?: string | null | undefined;
  avatarUrl?: string | null | undefined;
  /**
   * Set ONLY when the provider is the forge itself, so signing in with a forge
   * still auto-links "my PRs". A local or OIDC login leaves it undefined and
   * the link is claimed explicitly — inventing one from a matching email would
   * attribute someone's commits to whoever registered that address.
   */
  forgeUserId?: string | undefined;
}

/**
 * Resolves a subject to a user row, creating it on first sign-in.
 *
 * Upserts on (auth_provider, auth_subject) rather than on the forge id: the
 * same human may hold a local account and an OIDC account, and those are two
 * rows by design — merging them would mean deciding that two subjects are one
 * person on evidence we do not have.
 */
export async function findOrCreateUserForSubject(
  db: Database,
  subject: AuthenticatedSubject,
): Promise<typeof core.users.$inferSelect> {
  const [user] = await db
    .insert(core.users)
    .values({
      authProvider: subject.provider,
      authSubject: subject.subject,
      login: subject.login,
      email: subject.email ?? null,
      name: subject.name ?? null,
      avatarUrl: subject.avatarUrl ?? null,
      forgeUserId: subject.forgeUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [core.users.authProvider, core.users.authSubject],
      // Profile fields refresh on every sign-in; the forge link does NOT get
      // cleared by a later login that has no forge identity, or a local
      // sign-in would silently unlink a claim the user made deliberately.
      set: {
        login: subject.login,
        email: subject.email ?? null,
        name: subject.name ?? null,
        avatarUrl: subject.avatarUrl ?? null,
        ...(subject.forgeUserId ? { forgeUserId: subject.forgeUserId } : {}),
      },
    })
    .returning();

  if (!user) {
    throw new Error(
      `findOrCreateUserForSubject: upsert returned no row for ${subject.provider}:${subject.subject}`,
    );
  }
  return user;
}

/** The user behind a session, or null when the row has gone. */
export async function findUserById(
  db: Database,
  userId: number,
): Promise<typeof core.users.$inferSelect | null> {
  const [user] = await db.select().from(core.users).where(eq(core.users.id, userId)).limit(1);
  return user ?? null;
}

/**
 * Claims a forge identity for a user who did not sign in with the forge.
 *
 * REFUSES a forge id already claimed by someone else rather than moving it: two
 * people pointing at one committer would make "my PRs" wrong for both, and the
 * person who lost the link would never be told.
 */
export async function linkForgeIdentity(
  db: Database,
  userId: number,
  forgeUserId: string,
): Promise<{ ok: true } | { ok: false; reason: 'taken' }> {
  const [existing] = await db
    .select({ id: core.users.id })
    .from(core.users)
    .where(eq(core.users.forgeUserId, forgeUserId))
    .limit(1);

  if (existing && existing.id !== userId) return { ok: false, reason: 'taken' };

  await db.update(core.users).set({ forgeUserId }).where(eq(core.users.id, userId));
  return { ok: true };
}

/**
 * Points a member at the forge account behind a workspace's committer identity
 * (W20-10, UX_TODO ADM-43), for the admin "link identity" screen.
 *
 * Lives here, not in the route, because forge user ids are this module's
 * business (W15-05): the route deals in members and identities, and asks.
 * A committer with no forge id has nothing to claim and succeeds as a no-op.
 * A GitHub sign-in IS a forge account, so it is never re-pointed at a
 * different committer: its own work would vanish from its own screens.
 */
export async function linkMemberToCommitter(
  db: Database,
  input: { workspaceId: number; identityId: number; userId: number },
): Promise<{ ok: true } | { ok: false; reason: 'github_sign_in' | 'taken' }> {
  const [identity] = await db
    .select({ forgeUserId: core.identities.forgeUserId })
    .from(core.identities)
    .where(
      and(
        eq(core.identities.id, input.identityId),
        eq(core.identities.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const forgeUserId = identity?.forgeUserId;
  if (!forgeUserId) return { ok: true };

  const user = await findUserById(db, input.userId);
  if (
    user?.authProvider === 'github' &&
    user.forgeUserId !== null &&
    user.forgeUserId !== forgeUserId
  ) {
    return { ok: false, reason: 'github_sign_in' };
  }
  return linkForgeIdentity(db, input.userId, forgeUserId);
}

/** Looks a local account up by email, for the password path. */
export async function findLocalUserByEmail(
  db: Database,
  email: string,
): Promise<typeof core.users.$inferSelect | null> {
  const [user] = await db
    .select()
    .from(core.users)
    .where(
      and(eq(core.users.authProvider, 'local'), eq(core.users.authSubject, email.toLowerCase())),
    )
    .limit(1);
  return user ?? null;
}
