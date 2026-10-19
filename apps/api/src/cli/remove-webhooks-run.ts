import { and, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import { webhookUrlFor } from '../routes/connections/index.js';

// Remove the push webhooks RepoPulse registered (W20-15, UX_TODO X-27).
//
// Tracking a repository registers a hook on it. Taking RepoPulse down without
// removing them leaves every repository sending deliveries that fail to a
// server that no longer exists. deploy/uninstall.sh runs this first, while the
// database still says which repositories and connections there are.
//
// Hooks are found by their DELIVERY URL, not a stored id: the connect step
// never kept the id, and matching the URL also finds hooks from installs that
// predate this. A hook someone else registered for another service has a
// different URL and is never touched.

export interface RemoveWebhooksDeps {
  /** PUBLIC_BASE_URL + /api/v1/webhooks/github, as the API registers it. */
  webhookUrl: string;
  /** The budgeted provider for one repository (Law 7), paused ones included. */
  providerFor: (
    workspaceId: number,
    repoId: number,
  ) => Promise<{ provider: ForgeProvider; repoFullName: string } | null>;
}

export interface RemoveWebhooksResult {
  repos: number;
  removed: number;
  /** Repositories whose hooks could not be removed, with why. Do these by hand. */
  failed: { repo: string; error: string }[];
}

export async function removeWebhooks(
  db: Database,
  deps: RemoveWebhooksDeps,
): Promise<RemoveWebhooksResult> {
  const result: RemoveWebhooksResult = { repos: 0, removed: 0, failed: [] };
  const workspaces = await db.select({ id: core.workspaces.id }).from(core.workspaces);
  for (const ws of workspaces) {
    const repos = await db
      .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
      .from(core.repos)
      .innerJoin(
        core.forgeConnections,
        and(
          eq(core.forgeConnections.id, core.repos.connectionId),
          eq(core.forgeConnections.workspaceId, ws.id),
        ),
      )
      .where(and(eq(core.repos.workspaceId, ws.id), eq(core.forgeConnections.status, 'active')));
    // One at a time through the budgeted client: a burst of hook deletions is
    // what a secondary rate limit punishes.
    for (const repo of repos) {
      result.repos += 1;
      const fullName = `${repo.org}/${repo.name}`;
      try {
        const resolved = await deps.providerFor(ws.id, repo.id);
        if (!resolved) {
          result.failed.push({ repo: fullName, error: 'no usable connection for it' });
          continue;
        }
        const { provider } = resolved;
        if (!provider.deleteWebhooks) {
          result.failed.push({ repo: fullName, error: 'this forge cannot remove hooks here' });
          continue;
        }
        const url = webhookUrlFor(deps.webhookUrl, provider.capabilities.webhookScheme);
        result.removed += await provider.deleteWebhooks(
          { lane: 'user', repoId: String(repo.id) },
          resolved.repoFullName,
          url,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({ repo: fullName, error: message.slice(0, 300) });
      }
    }
  }
  return result;
}
