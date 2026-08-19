import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { createLogger, type Database, type Logger } from '@repopulse/shared';
import { oauth } from '@repopulse/auth';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUE, createQueue, createRedisConnection } from '@repopulse/ingest';
import authRoutes from './routes/auth/index.js';
import healthRoutes from './routes/health/index.js';
import errorEnvelopePlugin from './plugins/error-envelope.js';
import securityHeadersPlugin from './plugins/security-headers.js';
import rateLimitsPlugin from './plugins/rate-limits.js';
import csrfHeaderPlugin from './plugins/csrf-header.js';
import metricsPlugin from './plugins/metrics/index.js';
import apiV1 from './plugins/api-v1.js';
import webhookRoutes from './routes/webhooks/index.js';

export interface BuildAppOptions {
  db: Database;
  redisUrl: string;
  sessionSecret: string;
  idleTimeoutMs: number;
  absoluteLifetimeMs: number;
  cookieSecure: boolean;
  githubOAuth: oauth.GithubOAuthConfig;
  githubEndpoints?: oauth.GithubOAuthEndpoints;
  /** AES key for forge credentials at rest (FR-AUTH-5) — auth.loadTokenKey(). */
  tokenKey: Buffer;
  /** Absolute URL GitHub should POST deliveries to; shown when creating a connection. */
  webhookUrl: string;
  /** Forge API base URL. Unset = api.github.com; set for GHES or a self-hosted forge. */
  forgeBaseUrl?: string;
  /** Injectable queue lookup for DLQ replay (W4-20) — tests replay without Redis. */
  adminQueueFor?: (queue: string) => import('bullmq').Queue | undefined;
  loginRedirectUrl: string;
  /**
   * Demo mode (W13-02). Surfaced to the SPA via /me/context so the UI can say
   * plainly that this is fake data — a demo that looks identical to the real
   * product is how a screenshot of fixtures ends up in a decision meeting.
   * The API is the authority: a browser-side env flag could disagree with the
   * server it is talking to.
   */
  demo?: boolean;
  /** Test-only override so security tests can capture audit/redaction output. */
  loggerInstance?: Logger;
}

export function buildApp(opts: BuildAppOptions) {
  // SC-2: a custom pino instance (not `logger: true`) so every log line -
  // including every `request.log`/child logger, since pino's streamWrite
  // hook operates at the shared destination-stream level - passes through
  // the no-log-material redaction layer (verified: `loggerInstance` is the
  // Fastify 5.x option for a pre-built pino instance, not `logger`).
  const app = Fastify({
    loggerInstance: opts.loggerInstance ?? createLogger({ name: 'repopulse-api' }),
  });

  app.register(errorEnvelopePlugin);
  app.register(securityHeadersPlugin);
  app.register(rateLimitsPlugin);
  app.register(csrfHeaderPlugin);
  app.register(metricsPlugin);

  // Registered before the routes it documents — @fastify/swagger's onRoute
  // hook only catches routes added after this point.
  app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'RepoPulse API', version: '1' },
    },
    transform: jsonSchemaTransform,
  });

  app.register(authRoutes, {
    db: opts.db,
    redisUrl: opts.redisUrl,
    sessionSecret: opts.sessionSecret,
    idleTimeoutMs: opts.idleTimeoutMs,
    absoluteLifetimeMs: opts.absoluteLifetimeMs,
    cookieSecure: opts.cookieSecure,
    githubOAuth: opts.githubOAuth,
    loginRedirectUrl: opts.loginRedirectUrl,
    ...(opts.githubEndpoints ? { githubEndpoints: opts.githubEndpoints } : {}),
  });

  // Unauthenticated (API_DESIGN.md §1 exemption list + §5 liveness note).
  app.register(healthRoutes, { db: opts.db, redisUrl: opts.redisUrl });

  // Also unauthenticated: contract-testing tools (schemathesis, API_DESIGN.md
  // §5) need the spec before they can authenticate, and it carries no
  // tenant data — judgment call, not in the doc's literal exemption list;
  // documented in plan.json W1-04 notes.
  app.get('/api/v1/openapi.json', async () => app.swagger());

  // Ingest producers. The API enqueues; the worker process consumes. These are
  // built HERE rather than passed in as options so that tests and production
  // mount the identical app — the connections/webhooks routes existed and were
  // tested for two waves while never being registered in the real server, and
  // an option a test could omit is exactly how that stayed invisible (same
  // failure as the SSE route in W4-18).
  // Created on FIRST ENQUEUE, not at boot. Connecting eagerly opened a Redis
  // socket for every app instance — including the many test apps that never
  // enqueue and never call close() — which surfaced as ten unhandled EPIPE
  // errors and a non-zero exit while all 463 tests still reported passing.
  // Lazy construction also means a running API holds no idle producer socket
  // until it has something to publish.
  let queueConnection: Redis | undefined;
  let backfillQueue: Queue | undefined;
  let deltaQueue: Queue | undefined;
  const connection = () => (queueConnection ??= createRedisConnection(opts.redisUrl));
  let reportQueue: ReturnType<typeof createQueue> | undefined;
  const backfill = () => (backfillQueue ??= createQueue(QUEUE.backfill, connection()));
  const delta = () => (deltaQueue ??= createQueue(QUEUE.delta, connection()));
  // Lazily created like the others: an API process that never generates a
  // report should not hold a Redis connection for the privilege.
  const reportsQueue = () => (reportQueue ??= createQueue(QUEUE.reports, connection()));

  app.addHook('onClose', async () => {
    await backfillQueue?.close();
    await deltaQueue?.close();
    await reportQueue?.close();
    queueConnection?.disconnect();
  });

  app.register(apiV1, {
    db: opts.db,
    redisUrl: opts.redisUrl,
    tokenKey: opts.tokenKey,
    webhookUrl: opts.webhookUrl,
    ...(opts.forgeBaseUrl ? { forgeBaseUrl: opts.forgeBaseUrl } : {}),
    ...(opts.adminQueueFor ? { adminQueueFor: opts.adminQueueFor } : {}),
    demo: opts.demo ?? false,
    enqueueReport: async ({ reportId, workspaceId, params }) => {
      await reportsQueue().add('generate', { reportId, workspaceId, params });
    },
    // Scheduled generation (W5-09, R-A10) rides BullMQ's own repeatable jobs.
    // No schedules table: BullMQ already holds the timer AND can list it, so a
    // table would be a second source of truth able to disagree with reality.
    schedules: {
      list: async (workspaceId) => {
        const repeatables = await reportsQueue().getRepeatableJobs();
        return repeatables
          .filter((r) => r.name.startsWith(`schedule:${workspaceId}:`))
          .map((r) => {
            const [, , type, cadence] = r.name.split(':');
            return { key: r.key, type: type ?? '', cadence: cadence ?? '', next: r.next ?? null };
          });
      },
      add: async (workspaceId, type, cadence, windowDays) => {
        // Monthly on the 1st, quarterly on the 1st of Jan/Apr/Jul/Oct — both at
        // 03:00, after the nightly snapshot has written the numbers a report
        // reads. Generating before it would report yesterday's warehouse.
        const pattern = cadence === 'monthly' ? '0 3 1 * *' : '0 3 1 1,4,7,10 *';
        await reportsQueue().add(
          `schedule:${workspaceId}:${type}:${cadence}`,
          { scheduled: true, workspaceId, type, windowDays },
          { repeat: { pattern } },
        );
      },
      remove: async (_workspaceId, key) => {
        await reportsQueue().removeRepeatableByKey(key);
      },
    },
    enqueueBackfillPlan: async ({ workspaceId, repoId }) => {
      await backfill().add('plan', { workspaceId, repoId });
    },
    prefix: '/api/v1',
  });

  // Webhook receiver: an UNAUTHENTICATED sibling of /api/v1, deliberately. It
  // authenticates by HMAC signature (SC-3), not by session, so mounting it
  // inside the guarded scope would 401 every legitimate GitHub delivery.
  app.register(webhookRoutes, {
    db: opts.db,
    tokenKey: opts.tokenKey,
    enqueueDelta: async (spec) => {
      // jobId is the debounce key (push bursts coalesce per repo, INGESTION §6),
      // so it must reach BullMQ or every push becomes its own job.
      await delta().add(spec.data.kind, spec.data, {
        jobId: spec.opts.jobId,
        ...(spec.opts.delayMs === undefined ? {} : { delay: spec.opts.delayMs }),
      });
    },
    prefix: '/api/v1',
  });

  return app;
}
