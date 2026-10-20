import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { activateRepos, collectAllPages } from '@repopulse/ingest';
import {
  splitRepoFullName,
  type CallCtx,
  type ForgeCursor,
  type ForgeProvider,
  type ForgeRepo,
} from '@repopulse/forge';
import { readWorkspaceSettings } from '../lib/workspace-settings.js';
import { WEBHOOK_EVENTS, webhookUrlFor } from '../routes/connections/index.js';

// Auto-add new repositories (W20-17, UX_TODO INS-09).
//
// "Track all and auto-add new" used to track only the repositories that
// existed at that moment (W20-07 note). A repository-level webhook cannot tell
// us a NEW repository was created, so discovery runs in the nightly reconcile
// sweep: for each connection an admin opted in, list its repositories through
// the budgeted provider (Law 7) and track the ones not yet on it. activateRepos
// already skips tracked repositories (paused ones included, so pausing a repo
// is never undone here), reuses the connection's webhook secret and queues
// each new repository's backfill plan.

export interface AutoAddDeps {
  db: Database;
  tokenKeySeal: (plaintext: string) => Buffer;
  tokenKeyOpen: (sealed: Buffer) => string;
  /** PUBLIC_BASE_URL + /api/v1/webhooks/github, as the API registers hooks. */
  webhookUrl: string;
  /** The budgeted provider for one active connection, or null. */
  providerFor: (workspaceId: number, connectionId: number) => Promise<ForgeProvider | null>;
  enqueuePlan: (workspaceId: number, repoId: number) => Promise<void>;
}

export interface AutoAddResult {
  connections: number;
  added: number;
  failed: { connectionId: number; error: string }[];
}

const CTX: CallCtx = { lane: 'backfill' };

export async function autoAddNewRepos(
  deps: AutoAddDeps,
  workspaceId: number,
): Promise<AutoAddResult> {
  const result: AutoAddResult = { connections: 0, added: 0, failed: [] };
  const ids = (await readWorkspaceSettings(deps.db, workspaceId)).stored.auto_add_connection_ids;
  if (!ids || ids.length === 0) return result;

  const active = await deps.db
    .select({ id: core.forgeConnections.id })
    .from(core.forgeConnections)
    .where(
      and(
        eq(core.forgeConnections.workspaceId, workspaceId),
        inArray(core.forgeConnections.id, ids),
        eq(core.forgeConnections.status, 'active'),
      ),
    );

  for (const conn of active) {
    result.connections += 1;
    try {
      const forge = await deps.providerFor(workspaceId, conn.id);
      if (!forge) continue;
      const listed = await collectAllPages<ForgeRepo, ForgeCursor>((cursor) =>
        forge.listRepos(CTX, cursor),
      );
      const candidates = listed.items
        // An archived repository is not "new work to watch"; the picker still
        // offers it by hand.
        .filter((r) => !r.isArchived)
        .map((r) => {
          const { org, name } = splitRepoFullName(r.fullName, r.name);
          return {
            forgeRepoId: r.externalId,
            org,
            name,
            defaultBranch: r.defaultBranch,
            isPrivate: r.isPrivate,
            isArchived: r.isArchived,
            pushedAt: r.pushedAt,
          };
        });
      const url = webhookUrlFor(deps.webhookUrl, forge.capabilities.webhookScheme);
      const added = await activateRepos(
        {
          db: deps.db,
          sealSecret: deps.tokenKeySeal,
          openSecret: deps.tokenKeyOpen,
          registerWebhook: (repoFullName, secret) =>
            forge.registerWebhook(CTX, repoFullName, url, secret, WEBHOOK_EVENTS),
          enqueuePlan: (repoId) => deps.enqueuePlan(workspaceId, repoId),
          generateSecret: () => randomBytes(32).toString('hex'),
        },
        {
          workspaceId,
          connectionId: conn.id,
          candidates,
          selection: { allAutoAdd: true },
        },
      );
      result.added += added.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ connectionId: conn.id, error: message.slice(0, 300) });
    }
  }
  return result;
}
