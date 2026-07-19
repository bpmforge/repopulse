import { and, eq } from 'drizzle-orm';
import { core } from '@repopulse/shared';
import type { Database } from '@repopulse/shared';

// Identity mapping (FR-AUTH-6, D6): link a workspace user → their forge author
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
