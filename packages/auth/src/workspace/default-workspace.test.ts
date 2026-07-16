import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb } from '@repopulse/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_SLUG, ensureMembership } from './default-workspace.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('ensureMembership (live Postgres)', () => {
  const db = createDb(databaseUrl as string);
  const testLoginPrefix = `w1-04-test-${Date.now()}-`;
  const createdUserIds: number[] = [];

  async function makeUser(login: string) {
    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: `${testLoginPrefix}${login}`, login })
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
