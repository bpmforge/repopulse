import { and, eq } from 'drizzle-orm';
import type { Database } from '@repopulse/shared';
import { core } from '@repopulse/shared';

// FOUNDING_BRIEF D1 / FR-AUTH-3: launch ships a single `default` workspace
// with auto-membership. No workspace-selection UI exists at v1, so every
// authenticated user belongs to exactly this one.
export const DEFAULT_WORKSPACE_SLUG = 'default';

export type WorkspaceRole = 'admin' | 'member';

async function ensureDefaultWorkspace(db: Database) {
  const [existing] = await db
    .select()
    .from(core.workspaces)
    .where(eq(core.workspaces.slug, DEFAULT_WORKSPACE_SLUG))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(core.workspaces)
    .values({ slug: DEFAULT_WORKSPACE_SLUG, name: 'Default' })
    .onConflictDoNothing({ target: core.workspaces.slug })
    .returning();
  if (created) return created;

  // Lost the create race to a concurrent first request — read what won.
  const [row] = await db
    .select()
    .from(core.workspaces)
    .where(eq(core.workspaces.slug, DEFAULT_WORKSPACE_SLUG))
    .limit(1);
  if (!row) throw new Error('ensureDefaultWorkspace: workspace missing after onConflictDoNothing');
  return row;
}

export interface Membership {
  workspace: typeof core.workspaces.$inferSelect;
  role: WorkspaceRole;
}

// "Auto-membership on first login" (FR-AUTH-3) — resolved lazily on first
// authenticated request rather than in the OAuth callback (W1-03's scope),
// since that's where workspace context is actually needed.
//
// First member of the workspace becomes admin (undocumented in SRS/UX_SPEC,
// but UX_SPEC's "Connect your org (admin) / Ask an admin" empty-state copy
// assumes the setup user is admin and everyone else isn't — bootstrap
// requires *someone* start as admin or no admin route is ever reachable).
// The count-then-insert below has a narrow race window between two
// concurrent first-ever logins (both could read zero existing members and
// both insert as admin) — accepted for a launch-scale single workspace:
// the failure mode is "two admins" (redundant, not a privilege
// escalation), not a security hole, and isn't worth an advisory lock for
// this skeleton ticket.
export async function ensureMembership(db: Database, userId: number): Promise<Membership> {
  const workspace = await ensureDefaultWorkspace(db);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(core.workspaceMembers)
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspace.id),
          eq(core.workspaceMembers.userId, userId),
        ),
      )
      .limit(1);
    if (existing) return { workspace, role: existing.role as WorkspaceRole };

    const [anyMember] = await tx
      .select({ userId: core.workspaceMembers.userId })
      .from(core.workspaceMembers)
      .where(eq(core.workspaceMembers.workspaceId, workspace.id))
      .limit(1);
    const role: WorkspaceRole = anyMember ? 'member' : 'admin';

    await tx.insert(core.workspaceMembers).values({ workspaceId: workspace.id, userId, role });
    return { workspace, role };
  });
}
