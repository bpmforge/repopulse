import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureBootstrapAdmin } from './bootstrap.js';
import { createLocalUser, setLocalPassword, verifyLocalCredentials } from './accounts.js';
import { hashPassword } from './password.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const GOOD_PASSWORD = 'a properly long passphrase';

describeIfLiveInfra('local accounts + first-boot bootstrap (W15-02)', () => {
  const db = createDb(databaseUrl as string);

  // These tests own the local-account table: the bootstrap's idempotence rule
  // is "does ANY local account exist", so it cannot be exercised without
  // controlling that set. Safe on a dev database — nothing seeds local users
  // (the fixture user is auth_provider = 'github'), and a real dev admin is
  // recreated by the very bootstrap under test on the next boot.
  async function deleteAllLocalUsers(): Promise<void> {
    const rows = await db
      .select({ id: core.users.id })
      .from(core.users)
      .where(eq(core.users.authProvider, 'local'));
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return;
    // Membership first: workspace_members references users with no ON DELETE.
    await db.delete(core.workspaceMembers).where(inArray(core.workspaceMembers.userId, ids));
    await db.delete(core.users).where(inArray(core.users.id, ids));
  }

  beforeEach(deleteAllLocalUsers);

  describe('creating an account', () => {
    it('creates a local user who must change the password they were given', async () => {
      const created = await createLocalUser(db, { email: 'Alice@Example.com', password: GOOD_PASSWORD });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      // The subject is the NORMALISED email, or the same person typing a
      // different capitalisation gets a second account they cannot reach.
      expect(created.user.authProvider).toBe('local');
      expect(created.user.authSubject).toBe('alice@example.com');
      expect(created.user.mustChangePassword).toBe(true);
      expect(created.user.passwordHash).toMatch(/^scrypt\$/);
      // D14: the forge is not the identity provider any more, so a local
      // account has no forge link until someone claims one.
      expect(created.user.forgeUserId).toBeNull();
    });

    it('refuses a duplicate address and a password below the policy', async () => {
      await createLocalUser(db, { email: 'dup@example.com', password: GOOD_PASSWORD });
      await expect(
        createLocalUser(db, { email: 'DUP@example.com', password: GOOD_PASSWORD }),
      ).resolves.toMatchObject({ ok: false, reason: 'exists' });
      await expect(
        createLocalUser(db, { email: 'weak@example.com', password: 'short' }),
      ).resolves.toMatchObject({ ok: false, reason: 'weak_password' });
      await expect(
        createLocalUser(db, { email: 'not-an-email', password: GOOD_PASSWORD }),
      ).resolves.toMatchObject({ ok: false, reason: 'invalid_email' });
    });
  });

  describe('verifying credentials', () => {
    it('accepts the right password and rejects the wrong one', async () => {
      await createLocalUser(db, { email: 'bob@example.com', password: GOOD_PASSWORD });
      await expect(verifyLocalCredentials(db, 'BOB@example.com', GOOD_PASSWORD)).resolves.toMatchObject({ ok: true });
      await expect(verifyLocalCredentials(db, 'bob@example.com', 'wrong password!!')).resolves.toEqual({ ok: false });
    });

    it('gives an unknown address, a wrong password and a federated account the SAME answer', async () => {
      await createLocalUser(db, { email: 'known@example.com', password: GOOD_PASSWORD });
      // A GitHub account whose address someone guessed: it exists, it has no
      // local password, and it must not be distinguishable from a stranger.
      await db.insert(core.users).values({
        authProvider: 'github',
        authSubject: 'w15-02-federated',
        login: 'w15-02-federated',
        email: 'federated@example.com',
      });

      const unknown = await verifyLocalCredentials(db, 'nobody@example.com', GOOD_PASSWORD);
      const federated = await verifyLocalCredentials(db, 'federated@example.com', GOOD_PASSWORD);
      const wrong = await verifyLocalCredentials(db, 'known@example.com', 'not the password');
      // Structural: the outcome carries no reason at all, so no caller can leak one.
      expect(unknown).toEqual({ ok: false });
      expect(federated).toEqual({ ok: false });
      expect(wrong).toEqual({ ok: false });

      await db.delete(core.users).where(eq(core.users.authSubject, 'w15-02-federated'));
    });

    it('does the same scrypt work whether or not the account exists', async () => {
      await createLocalUser(db, { email: 'timing@example.com', password: GOOD_PASSWORD });

      // Median of several attempts: a single sample on a loaded machine says
      // nothing. The bound is deliberately loose — the claim under test is
      // "both branches perform a derivation", not "the times are equal to the
      // microsecond", and a tight bound here would only produce a flaky test.
      const median = async (email: string): Promise<number> => {
        const samples: number[] = [];
        for (let i = 0; i < 5; i += 1) {
          const started = process.hrtime.bigint();
          await verifyLocalCredentials(db, email, 'not the password');
          samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        }
        return samples.sort((a, b) => a - b)[2] as number;
      };

      const missing = await median('nobody-at-all@example.com');
      const present = await median('timing@example.com');
      // An early return on "no such user" would land here in well under a
      // millisecond against a ~40ms real derivation.
      expect(missing).toBeGreaterThan(10);
      expect(missing / present).toBeGreaterThan(0.4);
      expect(missing / present).toBeLessThan(2.5);
    });

    it('upgrades a hash written with weaker parameters on a successful login', async () => {
      const created = await createLocalUser(db, { email: 'legacy@example.com', password: GOOD_PASSWORD });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { randomBytes, scryptSync } = await import('node:crypto');
      const salt = randomBytes(16);
      const key = scryptSync(GOOD_PASSWORD, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const legacy = `scrypt$N=16384,r=8,p=1,keylen=32$${salt.toString('base64')}$${key.toString('base64')}`;
      await db.update(core.users).set({ passwordHash: legacy }).where(eq(core.users.id, created.user.id));

      await expect(verifyLocalCredentials(db, 'legacy@example.com', GOOD_PASSWORD)).resolves.toMatchObject({ ok: true });

      const [after] = await db.select().from(core.users).where(eq(core.users.id, created.user.id));
      expect(after?.passwordHash).not.toBe(legacy);
      expect(after?.passwordHash).toContain('N=32768');
      // Still the same password — the upgrade must be invisible to the user.
      await expect(verifyLocalCredentials(db, 'legacy@example.com', GOOD_PASSWORD)).resolves.toMatchObject({ ok: true });
    });
  });

  it('clears the forced-change flag only by actually setting a password', async () => {
    const created = await createLocalUser(db, { email: 'change@example.com', password: GOOD_PASSWORD });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(setLocalPassword(db, created.user.id, 'tiny')).resolves.toMatchObject({
      ok: false,
      reason: 'weak_password',
    });
    let [row] = await db.select().from(core.users).where(eq(core.users.id, created.user.id));
    expect(row?.mustChangePassword).toBe(true);

    await expect(setLocalPassword(db, created.user.id, 'a different long passphrase')).resolves.toEqual({ ok: true });
    [row] = await db.select().from(core.users).where(eq(core.users.id, created.user.id));
    expect(row?.mustChangePassword).toBe(false);
    await expect(verifyLocalCredentials(db, 'change@example.com', 'a different long passphrase')).resolves.toMatchObject({ ok: true });
  });

  describe('first-boot bootstrap', () => {
    const env = { email: 'admin@example.com', password: 'first boot passphrase' };

    it('creates the admin once and is a no-op on every boot after', async () => {
      const first = await ensureBootstrapAdmin(db, env);
      expect(first.status).toBe('created');
      if (first.status !== 'created') return;

      const [user] = await db.select().from(core.users).where(eq(core.users.id, first.userId));
      expect(user?.mustChangePassword).toBe(true);
      const hash = user?.passwordHash;

      // Rebooting must not rewrite the row — in particular it must not restore
      // the env password over one the admin has since changed.
      await setLocalPassword(db, first.userId, 'the admin chose this one');
      await expect(ensureBootstrapAdmin(db, env)).resolves.toEqual({ status: 'already_bootstrapped' });
      const [again] = await db.select().from(core.users).where(eq(core.users.id, first.userId));
      expect(again?.passwordHash).not.toBe(hash);
      expect(again?.mustChangePassword).toBe(false);
      await expect(verifyLocalCredentials(db, env.email, env.password)).resolves.toEqual({ ok: false });
    });

    it('makes the bootstrap admin an actual workspace admin', async () => {
      const result = await ensureBootstrapAdmin(db, env);
      expect(result.status).toBe('created');
      if (result.status !== 'created') return;
      const [membership] = await db
        .select()
        .from(core.workspaceMembers)
        .where(eq(core.workspaceMembers.userId, result.userId));
      // ensureMembership only awards admin to the FIRST member of the
      // workspace, and on an install where someone already signed in with a
      // forge that is not this account — so the bootstrap forces it.
      expect(membership?.role).toBe('admin');
    });

    it('does not resurrect a deleted admin while another local account remains', async () => {
      await createLocalUser(db, { email: 'someone.else@example.com', password: GOOD_PASSWORD });
      // The configured ADMIN_EMAIL has no row: it was offboarded. Recreating it
      // here would silently undo that on the next restart.
      await expect(ensureBootstrapAdmin(db, env)).resolves.toEqual({ status: 'already_bootstrapped' });
      const [ghost] = await db.select().from(core.users).where(eq(core.users.authSubject, env.email));
      expect(ghost).toBeUndefined();
    });

    it('finishes an interrupted creation rather than leaving the install with no admin', async () => {
      // The row and its password hash are two statements. Simulate a crash
      // between them: a local row exists, has no hash, and cannot log in.
      await db.insert(core.users).values({
        authProvider: 'local',
        authSubject: env.email,
        login: 'admin',
        email: env.email,
      });

      // The stub must not count as "already bootstrapped" — that is precisely
      // the state that would brick a fresh install.
      const result = await ensureBootstrapAdmin(db, env);
      expect(result.status).toBe('created');
      await expect(verifyLocalCredentials(db, env.email, env.password)).resolves.toMatchObject({
        ok: true,
      });
      // Repaired, not duplicated.
      const rows = await db.select().from(core.users).where(eq(core.users.authSubject, env.email));
      expect(rows).toHaveLength(1);
    });

    it('reports the truth instead of crashing when another process won the race', async () => {
      await expect(ensureBootstrapAdmin(db, env)).resolves.toMatchObject({ status: 'created' });
      // Two processes boot against one database (the API and the worker); the
      // loser must not exit non-zero over a race it was designed to lose.
      await expect(ensureBootstrapAdmin(db, env)).resolves.toEqual({
        status: 'already_bootstrapped',
      });
    });

    it('does nothing when ADMIN_EMAIL/ADMIN_PASSWORD are not configured', async () => {
      await expect(ensureBootstrapAdmin(db, {})).resolves.toEqual({ status: 'not_configured' });
      await expect(ensureBootstrapAdmin(db, { email: env.email })).resolves.toEqual({ status: 'not_configured' });
    });

    it('refuses to bring up a fresh install behind a weak ADMIN_PASSWORD, without logging it', async () => {
      const weak = 'hunter2';
      const error = await ensureBootstrapAdmin(db, { email: env.email, password: weak }).catch(
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/ADMIN_PASSWORD/);
      // The message names the rule, never the value: boot logs get pasted into
      // issues and chat far more casually than a password ever should be.
      expect((error as Error).message).not.toContain(weak);
      // Nothing was created, so the next boot with a real password still works.
      await expect(ensureBootstrapAdmin(db, env)).resolves.toMatchObject({ status: 'created' });
    });
  });

  it('never stores the plaintext anywhere on the row', async () => {
    const created = await createLocalUser(db, { email: 'nolabels@example.com', password: GOOD_PASSWORD });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [row] = await db.select().from(core.users).where(eq(core.users.id, created.user.id));
    expect(JSON.stringify(row)).not.toContain(GOOD_PASSWORD);
    // And a freshly written hash is verifiable, so "not the plaintext" is not
    // achieved by storing something useless.
    expect(await hashPassword(GOOD_PASSWORD)).not.toContain(GOOD_PASSWORD);
  });
});
