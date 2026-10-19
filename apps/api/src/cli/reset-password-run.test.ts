import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { core, createDb } from '@repopulse/shared';
import { local } from '@repopulse/auth';
import { resetPasswordByEmail } from './reset-password-run.js';

// W20-07 (UX_TODO INS-03): the CLI way back in for a locked-out admin.

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const EMAIL = 'w20-07-cli-admin@example.com';

describeIfDb('reset:password CLI (live)', () => {
  const db = createDb(databaseUrl as string);

  afterAll(async () => {
    await db.delete(core.users).where(eq(core.users.authSubject, EMAIL));
    await db.$client.end();
  });

  it('resets a local account found by email (any capitalisation) to a one-time password', async () => {
    const created = await local.createLocalUser(db, {
      email: EMAIL,
      password: 'a properly long passphrase',
      mustChangePassword: false,
    });
    expect(created.ok).toBe(true);

    const out = await resetPasswordByEmail(db, 'W20-07-CLI-Admin@Example.com');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await expect(
      local.verifyLocalCredentials(db, EMAIL, out.temporaryPassword),
    ).resolves.toMatchObject({
      ok: true,
      user: { mustChangePassword: true },
    });
  });

  it('says not_found for an address with no local account', async () => {
    await expect(resetPasswordByEmail(db, 'nobody-w20-07@example.com')).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
