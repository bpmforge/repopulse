import { and, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { local } from '@repopulse/auth';

// The decision half of `pnpm reset:password` (W20-07, UX_TODO INS-03), split
// from the process half in reset-password.ts so it can be tested.
//
// WHY A CLI AT ALL. The admin "Reset password" action in Settings → Members
// needs an admin who can sign in. A locked-out bootstrap admin is exactly the
// person who cannot, and changing ADMIN_EMAIL does nothing once any local
// account exists (the bootstrap is idempotent on that). Whoever can run a
// command in the api container already holds every secret this install has, so
// this grants nothing they did not have.

export type ResetByEmailOutcome =
  { ok: true; temporaryPassword: string; userId: number } | { ok: false; reason: 'not_found' };

export async function resetPasswordByEmail(
  db: Database,
  email: string,
): Promise<ResetByEmailOutcome> {
  const [user] = await db
    .select({ id: core.users.id })
    .from(core.users)
    .where(
      and(
        eq(core.users.authProvider, 'local'),
        eq(core.users.authSubject, local.normalizeEmail(email)),
      ),
    )
    .limit(1);
  if (!user) return { ok: false, reason: 'not_found' };
  const reset = await local.resetLocalPassword(db, user.id);
  if (!reset.ok) return { ok: false, reason: 'not_found' };
  return { ok: true, temporaryPassword: reset.temporaryPassword, userId: user.id };
}
