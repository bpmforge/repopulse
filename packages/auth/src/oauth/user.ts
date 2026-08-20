import { eq } from 'drizzle-orm';
import type { Database } from '@repopulse/shared';
import { core } from '@repopulse/shared';
import type { GithubIdentity } from './github.js';
import { findOrCreateUserForSubject } from '../identity-provider/index.js';

/**
 * GitHub OAuth is now ONE provider, not the mechanism (W15-01, D14).
 *
 * This forwards to the shared seam rather than upserting on `forge_user_id`
 * itself, so there is exactly one place that turns an authenticated subject
 * into a user row. It keeps `forgeUserId` because the forge IS the identity
 * here — which is the one case where "my PRs" can auto-link.
 */
export async function findOrCreateUser(db: Database, identity: GithubIdentity) {
  return findOrCreateUserForSubject(db, {
    provider: 'github',
    subject: identity.forgeUserId,
    login: identity.login,
    name: identity.name,
    avatarUrl: identity.avatarUrl,
    forgeUserId: identity.forgeUserId,
  });
}

export async function findUserById(db: Database, userId: number) {
  const [user] = await db.select().from(core.users).where(eq(core.users.id, userId)).limit(1);
  return user ?? null;
}
