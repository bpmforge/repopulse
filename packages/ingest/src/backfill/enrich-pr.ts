import { and, eq, isNull, sql } from 'drizzle-orm';
import { facts } from '@repopulse/shared';
import type { CallCtx, ForgeCheckRun, ForgeProvider, ForgeReviewComment } from '@repopulse/forge';
import type { Database } from '@repopulse/shared';
import type { DbOrTx } from './db.js';
import { fetchOrRefusal, recordEnrichmentOutcome } from './entity-error.js';
import { IdentityResolver } from './identity.js';
import { upsertCheckRuns, upsertReviewComments, upsertReviews, type RepoScope } from './writers.js';

// Per-PR enrichment: reviews and check runs (W12-05 follow-up, founder decision
// 2026-08-13 to broaden enrichment from "commit file churn" to "per-parent
// detail fetches").
//
// WHY HERE. Both are nested fetches keyed on a parent row that history must
// already have ingested — reviews by PR number, checks by head SHA — which is
// structurally identical to commit churn and unlike every paginated history
// entity, which is walked page-by-page at repo scope. INGESTION §3 listed
// `checks` in the history entity order, but processBackfillJob only accepts
// PaginatedEntity precisely because checks cannot be walked that way; that
// listing was the inconsistency, and this is where it is resolved.
//
// upsertReviews and upsertCheckRuns were both fully built and called by
// NOTHING until this module — the sixth instance of that pattern in this
// codebase.

export interface EnrichPrDeps {
  db: Database;
  provider: ForgeProvider;
  provider_kind?: 'github' | 'gitea' | 'gitlab';
}

export interface EnrichPrParams {
  workspaceId: number;
  repoId: number;
  repo: string;
  prNumber: number;
  /** Check runs are keyed on the commit, not the PR. */
  headSha: string;
}

/**
 * Fill reviews + check runs for one PR. Written in a single transaction so a
 * crash leaves the PR un-enriched (retryable) rather than half-enriched.
 */
export async function enrichPullRequest(
  deps: EnrichPrDeps,
  params: EnrichPrParams,
): Promise<{ reviews: number; checks: number; reviewComments: number }> {
  // Lowest-priority lane, matching enrich.ts: §2 says enrichment is drained by
  // leftover budget, and `Lane` has no 'enrich' member — 'reconcile' IS the
  // bottom lane.
  const ctx: CallCtx = { lane: 'reconcile', repoId: String(params.repoId) };
  const scope: RepoScope = { workspaceId: params.workspaceId, repoId: params.repoId };

  // Network first, outside the transaction — same discipline as the page
  // ingest loop, so a slow forge never holds a write lock. Each fetch is
  // guarded on its own (W17-38): a token without the checks scope must not
  // cost the reviews, and neither refusal may read as "zero" — it is recorded.
  // A transient failure throws out of here and the queue retries the job.
  const reviews = await fetchOrRefusal(() =>
    deps.provider.listReviews(ctx, params.repo, params.prNumber),
  );

  const checks = await fetchOrRefusal(async () => {
    const all: ForgeCheckRun[] = [];
    let cursor: string | undefined;
    do {
      const page = await deps.provider.listCheckRuns(ctx, params.repo, {
        headSha: params.headSha,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return all;
  });

  // W18-23: inline comment anchors, for the AI-reviewer metrics. Only where the
  // adapter has the fetch at all — Gitea and GitLab do not, and for them the
  // PR simply never gets review_comments_observed_at, which the metrics read
  // as "no line-level data", not as "no comments".
  const listComments = deps.provider.listReviewComments?.bind(deps.provider);
  const comments = listComments
    ? await fetchOrRefusal(async () => {
        const all: ForgeReviewComment[] = [];
        let cursor: string | undefined;
        do {
          const page = await listComments(ctx, params.repo, params.prNumber, cursor);
          all.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return all;
      })
    : null;
  const observedAt = new Date();

  return deps.db.transaction(async (tx) => {
    const resolver = new IdentityResolver(
      tx,
      params.workspaceId,
      deps.provider_kind ?? deps.provider.kind ?? 'github',
    );
    const r = reviews.refused
      ? 0
      : await upsertReviews(tx, scope, resolver, params.prNumber, reviews.value);
    const c = checks.refused ? 0 : await upsertCheckRuns(tx, scope, checks.value);
    await recordEnrichmentOutcome(tx, scope, 'reviews', reviews.refused ?? null);
    await recordEnrichmentOutcome(tx, scope, 'checks', checks.refused ?? null);
    let rc = 0;
    if (comments) {
      if (!comments.refused) {
        rc = await upsertReviewComments(
          tx,
          scope,
          resolver,
          params.prNumber,
          comments.value,
          observedAt,
        );
      }
      await recordEnrichmentOutcome(tx, scope, 'review_comments', comments.refused ?? null);
    }
    // Stamp the PR as enriched so the work-list below stops returning it. This
    // is the reviews/checks analogue of commits.stats_source='detail'; without
    // a marker the predicate would have to count child rows, and a PR with
    // genuinely zero reviews AND zero checks would look permanently pending.
    // Stamped on a refusal too: the reason is recorded above, and an
    // unstampable PR would hold the repo in backfilling forever.
    await tx
      .update(facts.pullRequests)
      .set({ enrichedAt: new Date() })
      .where(
        and(
          eq(facts.pullRequests.repoId, params.repoId),
          eq(facts.pullRequests.number, params.prNumber),
        ),
      );
    return { reviews: r, checks: c, reviewComments: rc };
  });
}

export interface PrNeedingEnrichment {
  number: number;
  headSha: string;
}

/** PRs whose reviews/checks have not been fetched yet, oldest first. */
export async function prsNeedingEnrichment(
  db: DbOrTx,
  repoId: number,
  limit = 500,
): Promise<PrNeedingEnrichment[]> {
  return db
    .select({ number: facts.pullRequests.number, headSha: facts.pullRequests.headSha })
    .from(facts.pullRequests)
    .where(and(eq(facts.pullRequests.repoId, repoId), isNull(facts.pullRequests.enrichedAt)))
    .orderBy(facts.pullRequests.number)
    .limit(limit);
}

/** True when every PR in the repo has had its reviews/checks fetched. */
export async function isPrEnrichmentDrained(db: DbOrTx, repoId: number): Promise<boolean> {
  return (await countPrsNeedingEnrichment(db, repoId)) === 0;
}

/** How many PRs still await reviews/checks — the fan-out's progress measure (W17-41). */
export async function countPrsNeedingEnrichment(db: DbOrTx, repoId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(facts.pullRequests)
    .where(and(eq(facts.pullRequests.repoId, repoId), isNull(facts.pullRequests.enrichedAt)));
  return row?.n ?? 0;
}
