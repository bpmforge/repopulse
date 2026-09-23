import 'dotenv/config';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { core, createDb, type Database } from '@repopulse/shared';
import { ensureBootstrapAdmin } from './bootstrap.js';
import { verifyPassword } from './password.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

/**
 * The first administrator (W15-02, D14) — the boot path W17-09 depends on and
 * which had NO test of its own.
 *
 * Without this call a fresh install has no way in at all, so every failure mode
 * here is "the customer cannot sign in to the product they just installed".
 */
describeIfDb('ensureBootstrapAdmin (D14, covered for W17-09)', () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl as string);
  });

  afterEach(async () => {
    // Only the accounts this file makes. `local` accounts are global state that
    // other suites also touch, so a blanket delete here would be someone else's
    // mystery failure later.
    await db.delete(core.users).where(eq(core.users.email, 'w17-09-first@example.com'));
    await db.delete(core.users).where(eq(core.users.email, 'w17-09-second@example.com'));
  });

  afterAll(async () => {
    await db.$client.end();
  });

  /** Is there any pre-existing local account? The function short-circuits on it. */
  async function anyLocalExists(): Promise<boolean> {
    const [row] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(and(eq(core.users.authProvider, 'local'), isNotNull(core.users.passwordHash)))
      .limit(1);
    return row !== undefined;
  }

  it('does nothing when unconfigured, rather than inventing an account', async () => {
    // A default admin password would be the same password on every install of
    // this product on the internet.
    expect(await ensureBootstrapAdmin(db, { email: undefined, password: undefined })).toEqual({
      status: 'not_configured',
    });
    expect(await ensureBootstrapAdmin(db, { email: 'x@example.com', password: undefined })).toEqual(
      { status: 'not_configured' },
    );
    expect(
      await ensureBootstrapAdmin(db, { email: undefined, password: 'longenoughpassword' }),
    ).toEqual({ status: 'not_configured' });
  });

  it('refuses a password below the policy minimum instead of booting reachable', async () => {
    // Only observable on a genuinely fresh install: an already-bootstrapped one
    // returns before the password is looked at, which is the point.
    if (await anyLocalExists()) return;

    await expect(
      ensureBootstrapAdmin(db, { email: 'w17-09-first@example.com', password: 'short' }),
    ).rejects.toThrow(/ADMIN_PASSWORD is not acceptable/);
  });

  it('never puts the password in the error it throws', async () => {
    if (await anyLocalExists()) return;

    const secret = 'hunter2';
    await expect(
      ensureBootstrapAdmin(db, { email: 'w17-09-first@example.com', password: secret }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }) as Error,
    );
  });

  it('creates the first admin with a FORCED password change', async () => {
    if (await anyLocalExists()) return;

    const result = await ensureBootstrapAdmin(db, {
      email: 'w17-09-first@example.com',
      password: 'a-long-enough-first-password',
    });
    expect(result.status).toBe('created');

    const [user] = await db
      .select()
      .from(core.users)
      .where(eq(core.users.email, 'w17-09-first@example.com'));
    expect(user).toBeDefined();
    // The operator who typed ADMIN_PASSWORD into a compose file is not
    // necessarily the person who will own the account.
    expect(user?.mustChangePassword).toBe(true);
    expect(user?.authProvider).toBe('local');
    // Stored hashed, never in plaintext.
    expect(user?.passwordHash).toBeTruthy();
    expect(user?.passwordHash).not.toContain('a-long-enough-first-password');
    // Signature is verifyPassword(stored, password) and it returns
    // { ok, needsRehash } — not a boolean, and not (password, stored).
    expect(
      (await verifyPassword(user?.passwordHash ?? '', 'a-long-enough-first-password')).ok,
    ).toBe(true);
  });

  it('is IDEMPOTENT — a second boot does not rewrite the password', async () => {
    // It runs on every boot of both the API and the worker. If it overwrote the
    // password, every restart would silently undo a password the operator had
    // since changed.
    if (await anyLocalExists()) return;

    await ensureBootstrapAdmin(db, {
      email: 'w17-09-first@example.com',
      password: 'a-long-enough-first-password',
    });
    const [before] = await db
      .select({ hash: core.users.passwordHash })
      .from(core.users)
      .where(eq(core.users.email, 'w17-09-first@example.com'));

    const second = await ensureBootstrapAdmin(db, {
      email: 'w17-09-second@example.com',
      password: 'a-completely-different-password',
    });

    expect(second.status).toBe('already_bootstrapped');
    // And it did NOT create the second account either: any local account at all
    // means this install is already bootstrapped.
    const [other] = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.email, 'w17-09-second@example.com'));
    expect(other).toBeUndefined();

    const [after] = await db
      .select({ hash: core.users.passwordHash })
      .from(core.users)
      .where(eq(core.users.email, 'w17-09-first@example.com'));
    expect(after?.hash).toBe(before?.hash);
  });
});
