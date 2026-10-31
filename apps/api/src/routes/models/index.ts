import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';

// Settings -> Models -> prompt-cache hit rate per model (W23-06).
//
// Tier-2/3 prompts are split into a static prefix (checklist + schema + rules)
// and a per-chunk tail so a provider's prompt cache can reuse the prefix. This
// is how an operator sees whether it did: cache-read tokens over input tokens
// across each model's most recent analysis runs. A model whose provider
// reports no cache figure shows 0%, and `reports_cache` says whether any run in
// the window reported one, so the page can tell "not caching" from "not
// measured".

export interface ModelCacheRoutesOptions {
  db: Database;
}

/** How many of a model's most recent runs the rate is computed over. */
export const CACHE_WINDOW_RUNS = 50;
const SCAN_LIMIT = 2000;

export interface CacheRunRow {
  model: string;
  promptTokens: number;
  cacheReadTokens: number;
}

export interface ModelCacheStat {
  model: string;
  runs: number;
  tokens_in: number;
  cache_read_tokens: number;
  /** cache_read / tokens_in, 0..100 with one decimal; null when no input tokens were recorded. */
  hit_pct: number | null;
  /** True when at least one run in the window reported a cache-read figure. */
  reports_cache: boolean;
}

/**
 * Per model, over its first `windowRuns` rows. `rows` must be newest-first, so
 * "the last N" is the first N seen for each model.
 */
export function cacheHitByModel(
  rows: CacheRunRow[],
  windowRuns: number = CACHE_WINDOW_RUNS,
): ModelCacheStat[] {
  const by = new Map<string, ModelCacheStat>();
  for (const r of rows) {
    const s = by.get(r.model) ?? {
      model: r.model,
      runs: 0,
      tokens_in: 0,
      cache_read_tokens: 0,
      hit_pct: null,
      reports_cache: false,
    };
    if (s.runs >= windowRuns) continue;
    s.runs += 1;
    s.tokens_in += r.promptTokens;
    s.cache_read_tokens += r.cacheReadTokens;
    if (r.cacheReadTokens > 0) s.reports_cache = true;
    by.set(r.model, s);
  }
  return [...by.values()]
    .map((s) => ({
      ...s,
      hit_pct: s.tokens_in > 0 ? Math.round((s.cache_read_tokens / s.tokens_in) * 1000) / 10 : null,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

export default async function modelCacheRoutes(
  app: FastifyInstance,
  opts: ModelCacheRoutesOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/admin/models/cache', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) {
      sendProblem(request, reply, 401, 'No active session', {});
      return reply;
    }
    const rows = await db
      .select({
        model: read.analysisRuns.modelId,
        promptTokens: read.analysisRuns.promptTokens,
        cacheReadTokens: read.analysisRuns.cacheReadTokens,
      })
      .from(read.analysisRuns)
      .where(
        and(
          eq(read.analysisRuns.workspaceId, workspaceId),
          eq(read.analysisRuns.status, 'succeeded'),
        ),
      )
      .orderBy(desc(read.analysisRuns.startedAt))
      .limit(SCAN_LIMIT);
    return reply.send({ window_runs: CACHE_WINDOW_RUNS, models: cacheHitByModel(rows) });
  });
}
