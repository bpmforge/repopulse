import type { Database } from '@repopulse/shared';
import type { CallCtx, EndpointFamily } from '../types.js';
import { validateBaseUrl } from './base-url.js';
import { ConcurrencyQueue } from './concurrency-queue.js';
import { computeEndpointKey, EtagCache } from './etag-cache.js';
import { ForgeBudgetParkedError } from './errors.js';
import { ForgeMetrics } from './metrics.js';
import { PrimaryBudget } from './primary-budget.js';
import { RateBucket } from './rate-bucket.js';
import { secondaryLimitBackoffMs, serverErrorBackoffMs } from './backoff.js';
import {
  parseGithubRateLimitHeaders,
  parseRetryAfterSeconds,
  type ParsedRateLimitHeaders,
} from './rate-limit-headers.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ForgeHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type RequestExecutor = (req: {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  /** Present for writes/GraphQL (POST/PATCH…); undefined for GETs. Additive
   * (W1-06): the GitHubProvider's GraphQL backfill and registerWebhook carry a
   * body that the executor forwards to the transport. Existing GET callers are
   * unaffected — body stays undefined. */
  body?: unknown;
}) => Promise<ForgeHttpResponse>;

export interface ForgeRequest {
  method: HttpMethod;
  url: string;
  family: EndpointFamily;
  params?: Record<string, unknown>;
  /** Points cost against the secondary family bucket; default 1, writes default writeCost. */
  cost?: number;
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Request body for writes/GraphQL — forwarded to the executor (W1-06). */
  body?: unknown;
}

export interface ForgeResponse extends ForgeHttpResponse {
  servedFromCache: boolean;
}

export interface BudgetedClientOptions {
  connectionId: number;
  workspaceId: number;
  db: Database;
  executor: RequestExecutor;
  /** Exact hostname allowlist (SC-12) - e.g. ['api.github.com']. */
  allowlist: readonly string[];
  installationId?: string | undefined;
  /** Gitea self-hosted has no rate limits (ForgeCapabilities.hasRateLimits) -> pass-through. */
  hasRateLimits?: boolean;
  /** FR-FORGE-3 configurable floor. */
  floor?: number;
  maxConcurrent?: number;
  restFamilyPointsPerMinute?: number;
  graphqlPointsPerMinute?: number;
  writeCost?: number;
  writeMinIntervalMs?: number;
  maxServerErrorRetries?: number;
  /** 401 on an App installation token: caller refreshes; retried once. */
  onUnauthorized?: () => Promise<void>;
  parseRateLimitHeaders?: (headers: Record<string, string>) => ParsedRateLimitHeaders;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

const DEFAULT_FLOOR = 100;
const DEFAULT_MAX_CONCURRENT = 100;
const DEFAULT_REST_FAMILY_POINTS_PER_MINUTE = 900;
const DEFAULT_GRAPHQL_POINTS_PER_MINUTE = 2000;
const DEFAULT_WRITE_COST = 5;
const DEFAULT_WRITE_MIN_INTERVAL_MS = 1000;
const DEFAULT_MAX_SERVER_ERROR_RETRIES = 3;

// FORGE_PROVIDER.md §3: every forge byte flows through this client (Law 7).
// Transport-agnostic - the executor is injected so this same class serves
// both an Octokit-backed GitHubProvider (W1-06) and a fetch-based Gitea
// adapter (W7-02) without depending on either.
export class BudgetedClient {
  private readonly connectionId: number;
  private readonly workspaceId: number;
  private readonly allowlist: readonly string[];
  private readonly executor: RequestExecutor;
  private readonly hasRateLimits: boolean;
  private readonly floor: number;
  private readonly writeCost: number;
  private readonly writeMinIntervalMs: number;
  private readonly maxServerErrorRetries: number;
  private readonly onUnauthorized: (() => Promise<void>) | undefined;
  private readonly parseRateLimitHeadersFn: (
    headers: Record<string, string>,
  ) => ParsedRateLimitHeaders;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  private readonly restPrimary: PrimaryBudget;
  private readonly graphqlPrimary: PrimaryBudget;
  private readonly familyBuckets = new Map<EndpointFamily, RateBucket>();
  private readonly lastWriteAt = new Map<EndpointFamily, number>();
  private readonly restFamilyPointsPerMinute: number;
  private readonly graphqlPointsPerMinute: number;
  private readonly concurrency: ConcurrencyQueue;
  readonly etagCache: EtagCache;
  readonly metrics = new ForgeMetrics();

  constructor(opts: BudgetedClientOptions) {
    this.connectionId = opts.connectionId;
    this.workspaceId = opts.workspaceId;
    this.executor = opts.executor;
    this.allowlist = opts.allowlist;
    this.hasRateLimits = opts.hasRateLimits ?? true;
    this.floor = opts.floor ?? DEFAULT_FLOOR;
    this.writeCost = opts.writeCost ?? DEFAULT_WRITE_COST;
    this.writeMinIntervalMs = opts.writeMinIntervalMs ?? DEFAULT_WRITE_MIN_INTERVAL_MS;
    this.maxServerErrorRetries = opts.maxServerErrorRetries ?? DEFAULT_MAX_SERVER_ERROR_RETRIES;
    this.onUnauthorized = opts.onUnauthorized;
    this.parseRateLimitHeadersFn = opts.parseRateLimitHeaders ?? parseGithubRateLimitHeaders;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.jitter = opts.jitter ?? Math.random;
    this.restFamilyPointsPerMinute =
      opts.restFamilyPointsPerMinute ?? DEFAULT_REST_FAMILY_POINTS_PER_MINUTE;
    this.graphqlPointsPerMinute = opts.graphqlPointsPerMinute ?? DEFAULT_GRAPHQL_POINTS_PER_MINUTE;

    this.restPrimary = new PrimaryBudget({ floor: this.floor });
    this.graphqlPrimary = new PrimaryBudget({ floor: this.floor });
    this.concurrency = new ConcurrencyQueue(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.etagCache = new EtagCache({
      db: opts.db,
      connectionId: opts.connectionId,
      workspaceId: opts.workspaceId,
      installationId: opts.installationId,
    });
  }

  primaryBudgetSnapshot(bucket: 'rest' | 'graphql' = 'rest') {
    return (bucket === 'graphql' ? this.graphqlPrimary : this.restPrimary).snapshot();
  }

  metricsSnapshot() {
    const primary = this.restPrimary.snapshot();
    return this.metrics.snapshot(primary.remaining, this.concurrency.queueDepth);
  }

  private familyBucket(family: EndpointFamily): RateBucket {
    let bucket = this.familyBuckets.get(family);
    if (!bucket) {
      const capacity =
        family === 'graphql' ? this.graphqlPointsPerMinute : this.restFamilyPointsPerMinute;
      bucket = new RateBucket(capacity, capacity, this.now());
      this.familyBuckets.set(family, bucket);
    }
    return bucket;
  }

  async request(ctx: CallCtx, req: ForgeRequest): Promise<ForgeResponse> {
    validateBaseUrl(req.url, { allowlist: this.allowlist });
    const url = new URL(req.url);
    const endpointKey = computeEndpointKey(req.method, url.pathname + url.search, req.params);
    const cached = await this.etagCache.lookup(endpointKey);

    const isWrite = req.method !== 'GET';
    const cost = req.cost ?? (isWrite ? this.writeCost : 1);
    const bucketKind: 'rest' | 'graphql' = req.family === 'graphql' ? 'graphql' : 'rest';
    const primary = bucketKind === 'graphql' ? this.graphqlPrimary : this.restPrimary;

    const release = await this.concurrency.acquire(ctx.lane);
    try {
      if (this.hasRateLimits && !primary.admits(ctx.lane)) {
        throw new ForgeBudgetParkedError(ctx.lane, 'primary-floor', primary.snapshot().resetAt);
      }
      if (isWrite) {
        const last = this.lastWriteAt.get(req.family);
        if (last !== undefined && this.now() - last < this.writeMinIntervalMs) {
          throw new ForgeBudgetParkedError(
            ctx.lane,
            'secondary-family',
            last + this.writeMinIntervalMs,
          );
        }
      }
      if (!this.familyBucket(req.family).tryConsume(cost, this.now())) {
        throw new ForgeBudgetParkedError(
          ctx.lane,
          bucketKind === 'graphql' ? 'graphql' : 'secondary-family',
          null,
        );
      }
      if (isWrite) this.lastWriteAt.set(req.family, this.now());
      if (this.hasRateLimits) primary.reserve(cost);

      const response = await this.dispatchWithRetry(ctx, req, cached, bucketKind, endpointKey);
      return response;
    } finally {
      release();
    }
  }

  private async dispatchWithRetry(
    ctx: CallCtx,
    req: ForgeRequest,
    cached: Awaited<ReturnType<EtagCache['lookup']>>,
    bucketKind: 'rest' | 'graphql',
    endpointKey: string,
  ): Promise<ForgeResponse> {
    const primary = bucketKind === 'graphql' ? this.graphqlPrimary : this.restPrimary;
    let serverErrorAttempt = 0;
    let usedAuthRefresh = false;

    for (;;) {
      const headers = {
        ...(req.getHeaders ? await req.getHeaders() : {}),
        ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
        ...(cached?.lastModified ? { 'If-Modified-Since': cached.lastModified } : {}),
      };
      const start = this.now();
      const res = await this.executor({
        method: req.method,
        url: req.url,
        headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      this.metrics.recordRequestSeconds((this.now() - start) / 1000);
      this.metrics.recordRequest(req.family, ctx.lane, res.status);
      this.metrics.recordPoints(
        bucketKind,
        req.cost ?? (req.method !== 'GET' ? this.writeCost : 1),
      );

      if (this.hasRateLimits) primary.seedFromHeaders(this.parseRateLimitHeadersFn(res.headers));

      if (res.status === 304 && cached) {
        return {
          status: 304,
          headers: res.headers,
          body: cached.cachedBody,
          servedFromCache: true,
        };
      }

      if ((res.status === 403 || res.status === 429) && this.looksLikeSecondaryLimit(res)) {
        const ms = secondaryLimitBackoffMs(
          {
            retryAfterSeconds: parseRetryAfterSeconds(res.headers),
            rateLimitResetAt: this.parseRateLimitHeadersFn(res.headers).resetAt,
          },
          serverErrorAttempt,
          this.now(),
        );
        await this.sleep(ms);
        continue; // requeue same lane
      }

      if (res.status >= 500 && res.status < 600) {
        if (serverErrorAttempt >= this.maxServerErrorRetries) {
          return { ...res, servedFromCache: false };
        }
        serverErrorAttempt++;
        await this.sleep(serverErrorBackoffMs(serverErrorAttempt, this.jitter()));
        continue;
      }

      if (res.status === 401 && this.onUnauthorized && !usedAuthRefresh) {
        usedAuthRefresh = true;
        await this.onUnauthorized();
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        const etag = res.headers.etag ?? res.headers.ETag;
        const lastModified = res.headers['last-modified'] ?? res.headers['Last-Modified'];
        if (etag || lastModified) {
          await this.etagCache.store(endpointKey, {
            etag: etag ?? null,
            lastModified: lastModified ?? null,
            status: res.status,
            body: res.body,
          });
        }
      }

      return { ...res, servedFromCache: false };
    }
  }

  private looksLikeSecondaryLimit(res: ForgeHttpResponse): boolean {
    const parsed = this.parseRateLimitHeadersFn(res.headers);
    const retryAfter = parseRetryAfterSeconds(res.headers);
    return retryAfter !== undefined || (parsed.remaining !== undefined && parsed.remaining <= 0);
  }
}
