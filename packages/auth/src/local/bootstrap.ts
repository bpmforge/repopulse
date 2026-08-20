import { and, eq, isNotNull } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { ensureMembership } from '../workspace/default-workspace.js';
import { createLocalUser, normalizeEmail } from './accounts.js';
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from './password.js';

export interface BootstrapAdminEnv {
  /** ADMIN_EMAIL. */
  email?: string | undefined;
  /** ADMIN_PASSWORD. Never logged, never returned, never stored in plaintext. */
  password?: string | undefined;
}

export type BootstrapAdminResult =
  | { status: 'created'; userId: number }
  /** A local account already exists, so this install has been bootstrapped. */
  | { status: 'already_bootstrapped' }
  /** No ADMIN_EMAIL/ADMIN_PASSWORD configured — a federated-only install. */
  | { status: 'not_configured' };

/**
 * Creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD.
 *
 * D14 chose this over "the first visitor claims the instance", which on a LAN
 * or a cloud box hands the install to whoever finds the URL first. The cost is
 * that the operator's shell history and the compose file both know the
 * password, which is exactly why the account is created with
 * `must_change_password` set: the env var is a delivery mechanism for a single
 * first login, not a credential.
 *
 * SAFE ON EVERY BOOT. The idempotence test is "does ANY local account exist",
 * not "does this email exist":
 *
 *  - It stops a second admin appearing when someone edits ADMIN_EMAIL later.
 *  - It stops a DELETED admin being resurrected on the next restart, which
 *    would quietly undo an offboarding, as long as some other local account
 *    remains.
 *
 * The case it cannot decide is an install whose ONLY local account was deleted:
 * that is indistinguishable from a fresh database, so the admin is recreated
 * (with a forced password change). That is the recovery path for locking
 * yourself out, and preserving it is worth more than defending against an
 * operator who deleted every local account on purpose while leaving
 * ADMIN_PASSWORD in the environment.
 *
 * @throws if configured with a password below the policy minimum. A fresh
 * install whose only credential is `admin` should stop and say so rather than
 * come up quietly reachable; because an already-bootstrapped install returns
 * before the password is ever looked at, this can never break a running one.
 */
export async function ensureBootstrapAdmin(
  db: Database,
  env: BootstrapAdminEnv,
): Promise<BootstrapAdminResult> {
  const email = env.email?.trim();
  const password = env.password;
  if (!email || !password) return { status: 'not_configured' };

  const [anyLocal] = await db
    .select({ id: core.users.id })
    .from(core.users)
    // A local row with no password hash is an interrupted creation, not an
    // account (see createLocalUser). Counting it as evidence that this install
    // was already bootstrapped is how an install ends up with no admin and no
    // way to make one.
    .where(and(eq(core.users.authProvider, 'local'), isNotNull(core.users.passwordHash)))
    .limit(1);
  if (anyLocal) return { status: 'already_bootstrapped' };

  const policyError = passwordPolicyError(password);
  if (policyError) {
    // The message names the rule, never the value — a boot log is copied into
    // issues and chat far more casually than a password ever should be.
    throw new Error(
      `ADMIN_PASSWORD is not acceptable: ${policyError} (minimum ${MIN_PASSWORD_LENGTH} characters)`,
    );
  }

  const created = await createLocalUser(db, {
    email: normalizeEmail(email),
    password,
    mustChangePassword: true,
  });
  if (!created.ok) {
    // 'exists' is not a failure: it means another process won the same race —
    // the API and the worker both boot against one database, and both will run
    // this. Report the truth rather than killing the loser's boot. Anything
    // else IS a failure, and a fresh install should stop and say so.
    if (created.reason === 'exists') return { status: 'already_bootstrapped' };
    throw new Error(`Could not create the bootstrap admin: ${created.reason}`);
  }

  // ensureMembership awards `admin` to the first MEMBER of the workspace, not
  // the first user, so on an install where someone had already signed in with a
  // forge the bootstrap account would land as a plain member — an "admin"
  // account that cannot reach the admin screens. Force the role afterwards:
  // this account is the administrator by definition of what it is for.
  const membership = await ensureMembership(db, created.user.id);
  if (membership.role !== 'admin') {
    await db
      .update(core.workspaceMembers)
      .set({ role: 'admin' })
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, membership.workspace.id),
          eq(core.workspaceMembers.userId, created.user.id),
        ),
      );
  }

  return { status: 'created', userId: created.user.id };
}
