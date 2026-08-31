import { eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';

// Who did it, recorded so it survives them (W16-59).
//
// History rows carry the actor's user id, and every one of those foreign keys
// is now ON DELETE SET NULL — which on its own would quietly rewrite the past.
// On `finding_events` it would do worse than lose a name: null ALREADY means
// something there, because the API reports `automatic: actor === null`, so a
// departed person's triage decisions would be reclassified as the analysis pass
// acting by itself.
//
// The login is therefore denormalised beside the id at write time. After a
// delete the row reads: no id, but a login — "a person, whose account has since
// been removed" — which is a different sentence from both "this user" and
// "automatic", and all three are things a reader needs to tell apart.

/**
 * The login of the user who is acting, for storing beside their id.
 *
 * Null only when there is no user — a background pass acting on its own. A
 * missing row would also produce null, and that is the right answer too: it
 * cannot be attributed to anyone.
 */
export async function actorLoginFor(db: Database, userId: number | null): Promise<string | null> {
  if (userId === null) return null;
  const [row] = await db
    .select({ login: core.users.login })
    .from(core.users)
    .where(eq(core.users.id, userId))
    .limit(1);
  return row?.login ?? null;
}
