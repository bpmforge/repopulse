import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { findLocalUserByEmail, findOrCreateUserForSubject } from '../identity-provider/index.js';
import {
  decoyPasswordHash,
  hashPassword,
  passwordPolicyError,
  verifyPassword,
} from './password.js';

export type UserRow = typeof core.users.$inferSelect;

/**
 * The subject of a local account IS its normalised email, so the same address
 * typed with different capitalisation is the same account. Normalisation has to
 * happen in exactly one place or "Alice@corp" creates a second account that
 * "alice@corp" can never log into.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type LocalAuthOutcome =
  /** Credentials were good. */
  | { ok: true; user: UserRow }
  /**
   * Deliberately carries NO reason. The caller must not be able to tell an
   * unknown address from a wrong password from a federated account, because
   * anything it can tell, it can leak into a response.
   */
  | { ok: false };

/**
 * Checks an email and password against the local account table.
 *
 * The three failing branches — no such user, a user with no local password
 * (a GitHub or OIDC account whose address someone guessed), and a wrong
 * password — all perform one full scrypt derivation and return the same value.
 * An early `return` on the first two is the classic account-enumeration bug:
 * the response body can be identical and the response TIME still answers the
 * question.
 */
export async function verifyLocalCredentials(
  db: Database,
  email: string,
  password: string,
): Promise<LocalAuthOutcome> {
  const user = await findLocalUserByEmail(db, normalizeEmail(email));
  const stored = user?.passwordHash ?? (await decoyPasswordHash());

  const result = await verifyPassword(stored, password);
  if (!result.ok || !user || !user.passwordHash) return { ok: false };

  if (result.needsRehash) {
    // The only moment the plaintext exists is a successful login, so this is
    // the only moment an old hash can be upgraded to today's cost.
    await db
      .update(core.users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(core.users.id, user.id));
  }

  return { ok: true, user };
}

export interface CreateLocalUserInput {
  email: string;
  password: string;
  /** Display name for the UI; defaults to the local part of the email. */
  login?: string | undefined;
  name?: string | null | undefined;
  /**
   * Whether the account must replace this password before it can reach
   * anything. True for every admin-created account and for the bootstrap
   * admin — whoever typed the password knows it, and that person is not
   * necessarily the person who will own the account.
   */
  mustChangePassword?: boolean | undefined;
}

export type CreateLocalUserOutcome =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'exists' | 'weak_password' | 'invalid_email'; detail?: string };

/**
 * Creates a local account. There is NO self-service signup path to this
 * function (D14): an admin creates users, or the first-boot bootstrap does.
 * A self-hosted install reachable on a LAN with an open registration form
 * belongs to whoever finds the URL.
 */
export async function createLocalUser(
  db: Database,
  input: CreateLocalUserInput,
): Promise<CreateLocalUserOutcome> {
  const email = normalizeEmail(input.email);
  // Not a validating parser — the RFC's real grammar accepts more than anyone
  // wants and we never send mail to this address. It exists to catch a typo'd
  // or empty field before it becomes an account nobody can log into.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: 'invalid_email' };
  }

  const policyError = passwordPolicyError(input.password);
  if (policyError) return { ok: false, reason: 'weak_password', detail: policyError };

  const existing = await findLocalUserByEmail(db, email);
  // A local row with NO password hash is not an account — it is an
  // interrupted creation. The row and the hash are two statements (the identity
  // seam deliberately knows nothing about credentials, so it cannot write one),
  // and a crash between them would otherwise leave an address that can never
  // log in and can never be created again: on a fresh install whose only local
  // account is that stub, the bootstrap would find "a local user exists" for
  // ever and the operator would have no admin and no way to make one. Finishing
  // it here is safe because a null hash can only arise that way — a federated
  // user has a different `auth_provider` and is never found by this lookup.
  if (existing && existing.passwordHash !== null) return { ok: false, reason: 'exists' };

  const login = input.login?.trim() || (email.split('@')[0] ?? email);
  // Through the identity seam, never a raw insert: (auth_provider,
  // auth_subject) is the identity key and this is the one place that decides
  // what a row for a subject looks like.
  const user =
    existing ??
    (await findOrCreateUserForSubject(db, {
      provider: 'local',
      subject: email,
      login,
      email,
      name: input.name ?? null,
    }));

  // The password is set in a second statement because the seam deliberately
  // knows nothing about credentials — a provider hands it a subject, not a
  // secret, which is what keeps a new provider from having to care.
  const [updated] = await db
    .update(core.users)
    .set({
      passwordHash: await hashPassword(input.password),
      mustChangePassword: input.mustChangePassword ?? true,
    })
    .where(eq(core.users.id, user.id))
    .returning();

  return { ok: true, user: updated ?? user };
}

export type SetPasswordOutcome =
  { ok: true } | { ok: false; reason: 'weak_password'; detail: string };

/**
 * Replaces a user's password and clears the forced-change flag.
 *
 * Clearing the flag here rather than at the call site means there is no way to
 * set a new password and forget to lift the gate, and no way to lift the gate
 * without setting one.
 */
export async function setLocalPassword(
  db: Database,
  userId: number,
  password: string,
): Promise<SetPasswordOutcome> {
  const policyError = passwordPolicyError(password);
  if (policyError) return { ok: false, reason: 'weak_password', detail: policyError };

  await db
    .update(core.users)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: false })
    .where(eq(core.users.id, userId));
  return { ok: true };
}

export type ResetPasswordOutcome =
  | { ok: true; temporaryPassword: string; user: UserRow }
  /** No such user, or one that signs in with GitHub/OIDC and has no password here. */
  | { ok: false; reason: 'not_found' | 'not_local' };

/**
 * Issues a one-time temporary password (W20-07, UX_TODO INS-03).
 *
 * There was no way back from a lost password: no "forgot password", no admin
 * reset, no CLI — and a locked-out bootstrap admin could not get in at all,
 * because changing ADMIN_EMAIL creates nothing once any local account exists.
 * This is the one primitive both the admin action (Members) and the operator
 * CLI call.
 *
 * The password is generated, never chosen: a human-picked "temporary" password
 * is usually a pattern. It is returned exactly once and stored only as a hash,
 * and `must_change_password` is set, so the only thing it can do is open the
 * forced-change screen — the same gate the bootstrap admin goes through.
 */
export async function resetLocalPassword(
  db: Database,
  userId: number,
  generate: () => string = () => randomBytes(18).toString('base64url'),
): Promise<ResetPasswordOutcome> {
  const [user] = await db.select().from(core.users).where(eq(core.users.id, userId)).limit(1);
  if (!user) return { ok: false, reason: 'not_found' };
  if (user.authProvider !== 'local') return { ok: false, reason: 'not_local' };

  const temporaryPassword = generate();
  const [updated] = await db
    .update(core.users)
    .set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true })
    .where(eq(core.users.id, userId))
    .returning();
  return { ok: true, temporaryPassword, user: updated ?? user };
}
