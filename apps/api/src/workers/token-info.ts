import { and, eq, isNull } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';

// Token owner and expiry for connections made before W20-25 (UX_TODO ADM-50).
//
// A new connection reads them at connect time. One made earlier has never been
// asked, so the nightly sweep asks once, through the budgeted provider (Law 7),
// for each active personal-token connection whose token_checked_at is null. A
// read that fails leaves it null and is tried again the next night; one that
// works is never repeated (replacing the token reads the new one's).

export interface TokenInfoDeps {
  db: Database;
  providerFor: (workspaceId: number, connectionId: number) => Promise<ForgeProvider | null>;
}

export async function readMissingTokenInfo(
  deps: TokenInfoDeps,
  workspaceId: number,
): Promise<{ read: number; failed: number }> {
  const rows = await deps.db
    .select({ id: core.forgeConnections.id })
    .from(core.forgeConnections)
    .where(
      and(
        eq(core.forgeConnections.workspaceId, workspaceId),
        eq(core.forgeConnections.status, 'active'),
        eq(core.forgeConnections.authKind, 'pat'),
        isNull(core.forgeConnections.tokenCheckedAt),
      ),
    );
  let read = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const forge = await deps.providerFor(workspaceId, row.id);
      if (!forge?.getTokenInfo) continue;
      const info = await forge.getTokenInfo({ lane: 'reconcile' });
      await deps.db
        .update(core.forgeConnections)
        .set({
          tokenOwnerLogin: info.ownerLogin,
          tokenExpiresAt: info.expiresAt,
          tokenCheckedAt: new Date(),
        })
        .where(
          and(
            eq(core.forgeConnections.id, row.id),
            eq(core.forgeConnections.workspaceId, workspaceId),
          ),
        );
      read += 1;
    } catch {
      // Never stops the sweep; tried again tomorrow.
      failed += 1;
    }
  }
  return { read, failed };
}
