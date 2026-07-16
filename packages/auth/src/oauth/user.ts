import { eq } from 'drizzle-orm';
import type { Database } from '@repopulse/shared';
import { core } from '@repopulse/shared';
import type { GithubIdentity } from './github.js';

export async function findOrCreateUser(db: Database, identity: GithubIdentity) {
  const [user] = await db
    .insert(core.users)
    .values({
      forgeUserId: identity.forgeUserId,
      login: identity.login,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    })
    .onConflictDoUpdate({
      target: core.users.forgeUserId,
      set: {
        login: identity.login,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
      },
    })
    .returning();
  if (!user) {
    throw new Error(
      `findOrCreateUser: upsert returned no row for forgeUserId=${identity.forgeUserId}`,
    );
  }
  return user;
}

export async function findUserById(db: Database, userId: number) {
  const [user] = await db.select().from(core.users).where(eq(core.users.id, userId)).limit(1);
  return user ?? null;
}
