import { ForgeBudgetParkedError } from '@repopulse/forge';
import type { CallCtx, ForgeProvider, Lane, SinceQuery } from '@repopulse/forge';
import type { Database } from '@repopulse/shared';
import { writeCursor } from './cursor.js';
import { IdentityResolver } from './identity.js';
import {
  upsertCommits,
  upsertDeployments,
  upsertIssues,
  upsertPullRequests,
  upsertReleases,
  type RepoScope,
} from './writers.js';

// The repo-wide paginated backfill entities. checks (per-head-SHA) and reviews
// (per-PR) are nested fetches handled in the enrichment phase (enrich.ts), not
// this flat paginator.
export type PaginatedEntity = 'prs' | 'commits' | 'issues' | 'releases' | 'deployments';

const DEFAULT_MAX_PAGES = 20;

interface FetchedPage {
  count: number;
  nextCursor: string | undefined;
  /** Applies the fetched page's upserts inside the checkpoint transaction. */
  apply: (
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    scope: RepoScope,
    resolver: IdentityResolver,
  ) => Promise<number>;
}

// Fetch one page per entity, returning a typed `apply` closure so the page's
// upserts run inside the same transaction as the cursor checkpoint.
async function fetchPage(
  provider: ForgeProvider,
  ctx: CallCtx,
  entity: PaginatedEntity,
  repo: string,
  q: SinceQuery,
): Promise<FetchedPage> {
  switch (entity) {
    case 'prs': {
      const page = await provider.listPullRequests(ctx, repo, q);
      return {
        count: page.items.length,
        nextCursor: page.nextCursor,
        apply: (tx, scope, resolver) => upsertPullRequests(tx, scope, resolver, page.items),
      };
    }
    case 'commits': {
      const page = await provider.listCommits(ctx, repo, q);
      return {
        count: page.items.length,
        nextCursor: page.nextCursor,
        apply: (tx, scope, resolver) => upsertCommits(tx, scope, resolver, page.items),
      };
    }
    case 'issues': {
      const page = await provider.listIssues(ctx, repo, q);
      return {
        count: page.items.length,
        nextCursor: page.nextCursor,
        apply: (tx, scope, resolver) => upsertIssues(tx, scope, resolver, page.items),
      };
    }
    case 'releases': {
      const page = await provider.listReleases(ctx, repo, q.cursor);
      return {
        count: page.items.length,
        nextCursor: page.nextCursor,
        apply: (tx, scope) => upsertReleases(tx, scope, page.items),
      };
    }
    case 'deployments': {
      const page = await provider.listDeployments(ctx, repo, q.cursor);
      return {
        count: page.items.length,
        nextCursor: page.nextCursor,
        apply: (tx, scope) => upsertDeployments(tx, scope, page.items),
      };
    }
  }
}

export interface BackfillDeps {
  db: Database;
  provider: ForgeProvider;
  /** ≤N pages per job then re-enqueue (INGESTION §3, default 20). */
  maxPagesPerJob?: number;
  provider_kind?: 'github' | 'gitea';
}

export interface BackfillParams {
  workspaceId: number;
  repoId: number;
  /** owner/name for the forge calls. */
  repo: string;
  entityType: PaginatedEntity;
  cursor?: string;
  since?: string;
  lane?: Lane;
}

export interface BackfillResult {
  pages: number;
  itemsTotal: number;
  /** true once the entity's last page is checkpointed (backfill_done). */
  done: boolean;
  /** Set when more pages remain (re-enqueue) OR when parked on budget. */
  nextCursor?: string;
  /** Present when the budget floor was hit — re-enqueue with this delay. */
  parkedUntilMs?: number;
}

/**
 * Ingest up to `maxPagesPerJob` pages of one entity. Each page: fetch (network,
 * outside the txn) → in one transaction upsert the page AND checkpoint the
 * cursor. On the budget floor, stop and report a resume cursor + reset time so
 * the caller re-enqueues with delay (no busy-wait). FR-INGEST-3/4.
 */
export async function ingestEntityPages(
  deps: BackfillDeps,
  params: BackfillParams,
): Promise<BackfillResult> {
  const maxPages = deps.maxPagesPerJob ?? DEFAULT_MAX_PAGES;
  const kind = deps.provider_kind ?? 'github';
  const ctx: CallCtx = { lane: params.lane ?? 'backfill', repoId: String(params.repoId) };
  const scope: RepoScope = { workspaceId: params.workspaceId, repoId: params.repoId };

  let cursor = params.cursor;
  let pages = 0;
  let itemsTotal = 0;

  while (pages < maxPages) {
    const q: SinceQuery = {
      ...(cursor ? { cursor } : {}),
      ...(params.since ? { since: params.since } : {}),
    };
    let page: FetchedPage;
    try {
      page = await fetchPage(deps.provider, ctx, params.entityType, params.repo, q);
    } catch (err) {
      if (err instanceof ForgeBudgetParkedError) {
        // Park: no rows written this round; resume from the same cursor after reset.
        return {
          pages,
          itemsTotal,
          done: false,
          ...(cursor ? { nextCursor: cursor } : {}),
          ...(err.resumeAt !== null ? { parkedUntilMs: err.resumeAt } : {}),
        };
      }
      throw err;
    }

    await deps.db.transaction(async (tx) => {
      const resolver = new IdentityResolver(tx, params.workspaceId, kind);
      await page.apply(tx, scope, resolver);
      await writeCursor(tx, scope, params.entityType, {
        cursorValue: page.nextCursor ?? null,
        backfillDone: page.nextCursor === undefined,
      });
    });

    pages++;
    itemsTotal += page.count;
    cursor = page.nextCursor;
    if (cursor === undefined) return { pages, itemsTotal, done: true };
  }

  return { pages, itemsTotal, done: false, ...(cursor ? { nextCursor: cursor } : {}) };
}
