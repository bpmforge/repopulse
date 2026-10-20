import { ForgeBudgetParkedError, ForgeHttpError } from '@repopulse/forge';
import type { CallCtx, ForgeProvider, ForgeRepoFeatures, Lane, SinceQuery } from '@repopulse/forge';
import type { Database } from '@repopulse/shared';
import { writeCursor } from './cursor.js';
import { entityErrorText, readEntityError, updateRepoEntityError } from './entity-error.js';
import { IdentityResolver, type Provider } from './identity.js';
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

// The same five as a value, so the planner's fan-out and the "is this repo's
// history complete?" check are driven by ONE list. sync_cursors also permits
// reviews/pr_files/checks/workflow_runs, which the enrichment phase writes —
// a completion check that asked "are all cursors done?" would start returning
// false the moment enrich lands, which is the sort of regression that stays
// invisible for weeks.
export const PAGINATED_ENTITIES: readonly PaginatedEntity[] = [
  'prs',
  'commits',
  'issues',
  'releases',
  'deployments',
];

const DEFAULT_MAX_PAGES = 20;

// W17-39: entities a repository owner can switch off, and the forges that
// actually report the switch in repo metadata. GitHub exposes only has_issues
// (its PRs and releases cannot be disabled through the API); asking GitHub
// about an empty releases list would spend a call to learn nothing.
const FEATURE_OF: Partial<Record<PaginatedEntity, keyof ForgeRepoFeatures>> = {
  issues: 'issues',
  prs: 'pullRequests',
  releases: 'releases',
};
const REPORTED_FEATURES: Record<ForgeProvider['kind'], readonly (keyof ForgeRepoFeatures)[]> = {
  github: ['issues'],
  gitea: ['issues', 'pullRequests', 'releases'],
  gitlab: ['issues', 'pullRequests', 'releases'],
};

/**
 * Is this entity's feature switched OFF on the repo? Only an explicit `false`
 * from the forge counts; a flag it did not send, or metadata it would not
 * serve, is "unknown" — and unknown keeps the W17-35 error, because a 404 is
 * also what a missing repo or a revoked token looks like. A budget park is
 * returned so the caller can park rather than guess.
 */
async function featureSwitchedOff(
  provider: ForgeProvider,
  ctx: CallCtx,
  repo: string,
  entity: PaginatedEntity,
): Promise<boolean | ForgeBudgetParkedError> {
  const key = FEATURE_OF[entity];
  // `?? []`: test doubles and future adapters may carry a kind not listed here.
  if (!key || !(REPORTED_FEATURES[provider.kind] ?? []).includes(key)) return false;
  try {
    return (await provider.getRepo(ctx, repo)).features?.[key] === false;
  } catch (err) {
    if (err instanceof ForgeBudgetParkedError) return err;
    return false;
  }
}

interface FetchedPage {
  count: number;
  /**
   * Items that are really this entity. GitHub's /issues also lists pull
   * requests — with Issues switched off it lists ONLY pull requests (git/git,
   * observed live) — so a page of them is not evidence the feature is on.
   */
  substantive: number;
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
        substantive: page.items.length,
        nextCursor: page.nextCursor,
        apply: (tx, scope, resolver) => upsertPullRequests(tx, scope, resolver, page.items),
      };
    }
    case 'commits': {
      const page = await provider.listCommits(ctx, repo, q);
      return {
        count: page.items.length,
        substantive: page.items.length,
        nextCursor: page.nextCursor,
        apply: (tx, scope, resolver) => upsertCommits(tx, scope, resolver, page.items),
      };
    }
    case 'issues': {
      const page = await provider.listIssues(ctx, repo, q);
      return {
        count: page.items.length,
        substantive: page.items.filter((i) => !i.isPullRequest).length,
        nextCursor: page.nextCursor,
        apply: (tx, scope, resolver) => upsertIssues(tx, scope, resolver, page.items),
      };
    }
    case 'releases': {
      const page = await provider.listReleases(ctx, repo, q.cursor);
      return {
        count: page.items.length,
        substantive: page.items.length,
        nextCursor: page.nextCursor,
        apply: (tx, scope) => upsertReleases(tx, scope, page.items),
      };
    }
    case 'deployments': {
      const page = await provider.listDeployments(ctx, repo, q.cursor);
      return {
        count: page.items.length,
        substantive: page.items.length,
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
  provider_kind?: 'github' | 'gitea' | 'gitlab';
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
  /**
   * W17-35: the forge permanently refused this entity (401/403/404/410/422).
   * The entity is finished — so the repo can still complete on the others —
   * and the refusal is recorded on sync_cursors and repos.last_error.
   */
  failed?: { status: number; message: string };
  /**
   * W17-39: the repo has this feature switched off. Finished and empty, with no
   * error recorded — "not enabled on this repo" is information, not a failure.
   */
  notEnabled?: true;
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
  // W20-17: the identity's provider is the forge it came from. provider_kind
  // was never passed by the workers, so every Gitea and GitLab committer was
  // stored as a GitHub identity.
  const kind: Provider = deps.provider_kind ?? deps.provider.kind ?? 'github';
  const ctx: CallCtx = { lane: params.lane ?? 'backfill', repoId: String(params.repoId) };
  const scope: RepoScope = { workspaceId: params.workspaceId, repoId: params.repoId };

  let cursor = params.cursor;
  let pages = 0;
  let itemsTotal = 0;
  // A failure recorded by an earlier run, cleared by the first page that lands.
  let recordedError = await readEntityError(deps.db, params.repoId, params.entityType);

  const parkedAt = (err: ForgeBudgetParkedError): BackfillResult => ({
    pages,
    itemsTotal,
    done: false,
    ...(cursor ? { nextCursor: cursor } : {}),
    ...(err.resumeAt !== null ? { parkedUntilMs: err.resumeAt } : {}),
  });
  // Finish the entity as "not enabled": empty, done, no error — and remove any
  // error an earlier run recorded for it (a pre-W17-39 run read the 404 as one).
  const finishNotEnabled = async (): Promise<BackfillResult> => {
    await deps.db.transaction(async (tx) => {
      await writeCursor(tx, scope, params.entityType, {
        cursorValue: null,
        backfillDone: true,
        lastError: null,
        featureDisabled: true,
      });
      await updateRepoEntityError(tx, params.repoId, recordedError, null);
    });
    return { pages, itemsTotal, done: true, notEnabled: true };
  };

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
        return parkedAt(err);
      }
      if (err instanceof ForgeHttpError && err.permanent) {
        // A switched-off feature answers 404 on Gitea (1.24.7, observed live),
        // exactly like a missing repo or a revoked token: the metadata decides.
        const off = await featureSwitchedOff(deps.provider, ctx, params.repo, params.entityType);
        if (off instanceof ForgeBudgetParkedError) return parkedAt(off);
        if (off) return finishNotEnabled();
        // Retrying cannot change a 403, and reading it as "no items" is what
        // hid a token without read:issue behind a repo that looked complete.
        const message = entityErrorText(params.entityType, err);
        await deps.db.transaction(async (tx) => {
          await writeCursor(tx, scope, params.entityType, {
            cursorValue: cursor ?? null,
            backfillDone: true,
            lastError: message,
          });
          await updateRepoEntityError(tx, params.repoId, recordedError, message);
        });
        return { pages, itemsTotal, done: true, failed: { status: err.status, message } };
      }
      // 5xx that outlived the client's retries, a 429, a network error: fail the
      // job so the queue retries it and dead-letters it if it persists.
      throw err;
    }

    // GitHub answers a switched-off Issues with 200: empty, or pull requests
    // only. On the first page of a walk with nothing real in it, ask the repo;
    // if the feature is off, stop here rather than walk every PR via /issues.
    if (pages === 0 && !params.cursor && page.substantive === 0) {
      const off = await featureSwitchedOff(deps.provider, ctx, params.repo, params.entityType);
      if (off instanceof ForgeBudgetParkedError) return parkedAt(off);
      if (off) return finishNotEnabled();
    }

    await deps.db.transaction(async (tx) => {
      const resolver = new IdentityResolver(tx, params.workspaceId, kind);
      await page.apply(tx, scope, resolver);
      await writeCursor(tx, scope, params.entityType, {
        cursorValue: page.nextCursor ?? null,
        backfillDone: page.nextCursor === undefined,
      });
      if (recordedError !== null) {
        await updateRepoEntityError(tx, params.repoId, recordedError, null);
      }
    });
    recordedError = null;

    pages++;
    itemsTotal += page.count;
    cursor = page.nextCursor;
    if (cursor === undefined) return { pages, itemsTotal, done: true };
  }

  return { pages, itemsTotal, done: false, ...(cursor ? { nextCursor: cursor } : {}) };
}
