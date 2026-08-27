import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_SLUG, UnknownUserError, ensureMembership } from './default-workspace.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('ensureMembership (live Postgres)', () => {
  const db = createDb(databaseUrl as string);
  const testLoginPrefix = `w1-04-test-${Date.now()}-`;
  const createdUserIds: number[] = [];

  async function makeUser(login: string) {
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: `${testLoginPrefix}${login}`, forgeUserId: `${testLoginPrefix}${login}`, login })
      .returning();
    if (!user) throw new Error('user insert returned no row');
    createdUserIds.push(user.id);
    return user;
  }

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(core.workspaceMembers).where(eq(core.workspaceMembers.userId, id));
      await db.delete(core.users).where(eq(core.users.id, id));
    }
    await db.$client.end();
  });

  it('is idempotent and returns the same role on repeat calls', async () => {
    const user = await makeUser('idempotent-user');
    const first = await ensureMembership(db, user.id);
    const second = await ensureMembership(db, user.id);
    expect(first.workspace.slug).toBe(DEFAULT_WORKSPACE_SLUG);
    expect(second.role).toBe(first.role);
    expect(second.workspace.id).toBe(first.workspace.id);
  });

  it('makes the first member of the workspace admin and later members plain members', async () => {
    // Clean slate: remove every membership row for the default workspace so
    // "first member" is well-defined for this assertion.
    const [workspace] = await db
      .select()
      .from(core.workspaces)
      .where(eq(core.workspaces.slug, DEFAULT_WORKSPACE_SLUG))
      .limit(1);
    if (workspace) {
      await db
        .delete(core.workspaceMembers)
        .where(eq(core.workspaceMembers.workspaceId, workspace.id));
    }

    const first = await makeUser('first-member');
    const second = await makeUser('second-member');

    const firstMembership = await ensureMembership(db, first.id);
    const secondMembership = await ensureMembership(db, second.id);

    expect(firstMembership.role).toBe('admin');
    expect(secondMembership.role).toBe('member');
  });
});

// W16-15. A session naming a deleted user used to reach the INSERT below and
// violate workspace_members_user_id_users_id_fk, surfacing as a 500 — and the
// shell, which has no branch for a 500 on /me/context, then sat on "Checking
// your session…" for ever with no error, no retry and no sign-out. A browser in
// that state could only be recovered by clearing cookies.
//
// Reachable whenever an admin removes someone who is signed in elsewhere. Found
// twice by accident during the 2026-08-27 user walk.
describeIfDb('a session naming a deleted user (W16-15)', () => {
  const db = createDb(databaseUrl as string);

  afterAll(async () => {
    await db.$client.end();
  });

  it('throws UnknownUserError rather than violating the foreign key', async () => {
    // An id that cannot exist. The point is the CLASS of answer: a typed error
    // the caller can turn into 401, not a PostgresError that becomes a 500.
    await expect(ensureMembership(db, 2_147_483_600)).rejects.toBeInstanceOf(UnknownUserError);
  });

  it('names the user in the message, so the log line is actionable', async () => {
    await expect(ensureMembership(db, 2_147_483_601)).rejects.toThrow(/no longer exists/i);
  });

  it('writes no membership row for a user that does not exist', async () => {
    // The failure mode this guards: a half-written membership for a ghost user
    // would make the next request fail differently and even harder to explain.
    const before = await db.select().from(core.workspaceMembers);
    await ensureMembership(db, 2_147_483_602).catch(() => undefined);
    const after = await db.select().from(core.workspaceMembers);
    expect(after).toHaveLength(before.length);
  });
});
