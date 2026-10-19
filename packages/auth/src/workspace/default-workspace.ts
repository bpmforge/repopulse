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
// The first LOCAL account to join a workspace with no admin becomes admin.
// UX_SPEC's "Connect your org (admin) / Ask an admin" empty-state copy assumes
// the setup user is admin and everyone else isn't — bootstrap requires
// *someone* start as admin or no admin route is ever reachable.
//
// W20-07 (UX_TODO INS-74): this used to be the first member of ANY kind. On
// an install with no ADMIN_EMAIL but with OIDC or "Sign in with GitHub" on,
// that made whoever signed in first the admin — on a GitHub sign-in install,
// anyone with a GitHub account who found the URL. That is the "first visitor
// claims the instance" model D14 rejected. A local account, by contrast, only
// exists because the operator's ADMIN_EMAIL/ADMIN_PASSWORD bootstrap or an
// admin created it, so it is the one kind of first member whose admin role
// was configured rather than claimed. A federated-only install with no admin
// configured gets members only, and says so (Setup, /me/context `has_admin`,
// up.sh) until the operator sets ADMIN_EMAIL/ADMIN_PASSWORD and restarts.
// The count-then-insert below has a narrow race window between two
// concurrent first-ever logins (both could read zero existing members and
// both insert as admin) — accepted for a launch-scale single workspace:
// the failure mode is "two admins" (redundant, not a privilege
// escalation), not a security hole, and isn't worth an advisory lock for
// this skeleton ticket.
/**
 * Thrown when the session names a user that no longer exists (W16-15).
 *
 * A distinct type rather than a generic Error so the caller can answer 401 —
 * "this session is no longer valid" — instead of letting a foreign-key
 * violation surface as a 500.
 */
export class UnknownUserError extends Error {
  constructor(readonly userId: number) {
    super(`No user ${userId} — the session names an account that no longer exists`);
    this.name = 'UnknownUserError';
  }
}

/** Whether the workspace has at least one admin (W20-07, UX_TODO INS-74). */
export async function workspaceHasAdmin(db: Database, workspaceId: number): Promise<boolean> {
  const [row] = await db
    .select({ userId: core.workspaceMembers.userId })
    .from(core.workspaceMembers)
    .where(
      and(
        eq(core.workspaceMembers.workspaceId, workspaceId),
        eq(core.workspaceMembers.role, 'admin'),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function ensureMembership(db: Database, userId: number): Promise<Membership> {
  const workspace = await ensureDefaultWorkspace(db);

  return db.transaction(async (tx) => {
    // THE USER MUST STILL EXIST (W16-15).
    //
    // Without this the insert below violates
    // workspace_members_user_id_users_id_fk and surfaces as a 500 — and the
    // shell, which has no branch for a 500 on /me/context, sat on "Checking
    // your session…" for ever with no error, no retry and no way to sign out.
    // A browser in that state is unrecoverable without clearing cookies.
    //
    // Reachable in any install where an admin removes someone who is signed in
    // elsewhere; found twice by accident during the 2026-08-27 user walk.
    //
    // Checked HERE rather than in the api-v1 preHandler because five call sites
    // reach this function — /auth/identity and two paths in the local-auth
    // routes among them — and fixing one would have left the same 500 reachable
    // from the others.
    const [user] = await tx
      .select({ id: core.users.id, authProvider: core.users.authProvider })
      .from(core.users)
      .where(eq(core.users.id, userId))
      .limit(1);
    if (!user) throw new UnknownUserError(userId);

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

    const [anyAdmin] = await tx
      .select({ userId: core.workspaceMembers.userId })
      .from(core.workspaceMembers)
      .where(
        and(
          eq(core.workspaceMembers.workspaceId, workspace.id),
          eq(core.workspaceMembers.role, 'admin'),
        ),
      )
      .limit(1);
    const role: WorkspaceRole = !anyAdmin && user.authProvider === 'local' ? 'admin' : 'member';

    await tx.insert(core.workspaceMembers).values({ workspaceId: workspace.id, userId, role });
    return { workspace, role };
  });
}
