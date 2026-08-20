import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import type { Database } from '@repopulse/shared';

// Identity mapping (FR-AUTH-6, D14): link a workspace user → their forge author
// identity so "my PRs" / "my review load" resolve. The identities table is the
// forge-login→human map; a logged-in user is matched to their identity by
// forge_user_id and the link (`identities.user_id`) is memoized on first
// resolve. Returns the RAW identity id (facts FK the raw identity; merges
// resolve through COALESCE(merged_into_id, id) elsewhere — DATABASE §2).

export async function resolveUserIdentity(
  db: Database,
  workspaceId: number,
  userId: number,
): Promise<number | null> {
  // Already linked?
  const [linked] = await db
    .select({ id: core.identities.id })
    .from(core.identities)
    .where(and(eq(core.identities.workspaceId, workspaceId), eq(core.identities.userId, userId)))
    .limit(1);
  if (linked) return linked.id;

  // Link by forge_user_id (auto-link on first personalized request).
  const [user] = await db
    .select({ forgeUserId: core.users.forgeUserId })
    .from(core.users)
    .where(eq(core.users.id, userId))
    .limit(1);
  if (!user) return null;

  // NO FORGE LINK YET (W15-01). Since D14 a person can sign in with a local
  // account or their company IdP, so `forge_user_id` is nullable and this is an
  // ordinary state rather than a fault. It is also NOT the same as "linked but
  // has authored nothing" — the caller has to tell those apart, because one is
  // fixed by claiming an identity and the other by writing some code. Both
  // return null here; `identityLinkState` below says which.
  if (!user.forgeUserId) return null;

  const [identity] = await db
    .select({ id: core.identities.id })
    .from(core.identities)
    .where(
      and(
        eq(core.identities.workspaceId, workspaceId),
        eq(core.identities.forgeUserId, user.forgeUserId),
      ),
    )
    .limit(1);
  if (!identity) return null; // the user hasn't authored anything ingested yet

  await db.update(core.identities).set({ userId }).where(eq(core.identities.id, identity.id));
  return identity.id;
}

export type IdentityLinkState =
  /** The user has claimed a forge account and it has authored ingested work. */
  | { state: 'linked'; identityId: number }
  /** Signed in without a forge account and has not claimed one yet. */
  | { state: 'unlinked' }
  /** Claimed a forge account, but nothing of theirs has been ingested. */
  | { state: 'no_activity' };

/**
 * Why a personalized view is empty.
 *
 * Exists so the UI never renders "0 pull requests" at someone whose account
 * simply is not connected to a committer. Those are different sentences and
 * only one of them is about their work.
 */
export async function identityLinkState(
  db: Database,
  workspaceId: number,
  userId: number,
): Promise<IdentityLinkState> {
  const identityId = await resolveUserIdentity(db, workspaceId, userId);
  if (identityId !== null) return { state: 'linked', identityId };

  const [user] = await db
    .select({ forgeUserId: core.users.forgeUserId })
    .from(core.users)
    .where(eq(core.users.id, userId))
    .limit(1);

  return user?.forgeUserId ? { state: 'no_activity' } : { state: 'unlinked' };
}
