import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';

// Shared live-Postgres fixture helpers for W1-05 tests (same pattern as
// packages/auth's live-infra test suites). A forge_etag row FKs to
// forge_connections + workspaces, so both must exist first.
export const databaseUrl = process.env.DATABASE_URL;

export interface SeededFixture {
  workspaceId: number;
  connectionId: number;
  userId: number;
}

export async function seedWorkspaceAndConnection(
  db: Database,
  opts: { workspaceSlug: string; forgeUserId: string },
): Promise<SeededFixture> {
  const [workspace] = await db
    .insert(core.workspaces)
    .values({ slug: opts.workspaceSlug, name: opts.workspaceSlug })
    .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: opts.workspaceSlug } })
    .returning();
  if (!workspace) throw new Error('workspace upsert returned no row');

  const [user] = await db
    .insert(core.users)
    .values({ authProvider: 'github', authSubject: opts.forgeUserId, forgeUserId: opts.forgeUserId, login: opts.forgeUserId })
    .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: opts.forgeUserId } })
    .returning();
  if (!user) throw new Error('user upsert returned no row');

  const [connection] = await db
    .insert(core.forgeConnections)
    .values({
      workspaceId: workspace.id,
      provider: 'github',
      authKind: 'pat',
      credentialCiphertext: Buffer.from('test-ciphertext'),
      credentialIv: Buffer.from('test-iv-12345678'),
      keyVersion: 1,
      credentialFingerprint: `fp-${opts.forgeUserId}`,
      status: 'active',
      createdBy: user.id,
    })
    .returning();
  if (!connection) throw new Error('forge connection insert returned no row');

  return { workspaceId: workspace.id, connectionId: connection.id, userId: user.id };
}

export async function cleanupFixture(db: Database, ids: SeededFixture): Promise<void> {
  await db.delete(core.forgeEtag).where(eq(core.forgeEtag.connectionId, ids.connectionId));
  await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, ids.connectionId));
  await db.delete(core.workspaces).where(eq(core.workspaces.id, ids.workspaceId));
  await db.delete(core.users).where(eq(core.users.id, ids.userId));
}

export { createDb };
