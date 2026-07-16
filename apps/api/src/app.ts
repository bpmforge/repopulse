import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import fastifySwagger from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { Database } from '@repopulse/shared';
import { oauth } from '@repopulse/auth';
import authRoutes from './routes/auth/index.js';
import errorEnvelopePlugin from './plugins/error-envelope.js';
import apiV1 from './plugins/api-v1.js';
import { sendProblem } from './lib/problem.js';

export interface BuildAppOptions {
  db: Database;
  redisUrl: string;
  sessionSecret: string;
  idleTimeoutMs: number;
  absoluteLifetimeMs: number;
  cookieSecure: boolean;
  githubOAuth: oauth.GithubOAuthConfig;
  githubEndpoints?: oauth.GithubOAuthEndpoints;
  loginRedirectUrl: string;
}

export function buildApp(opts: BuildAppOptions) {
  const app = Fastify({ logger: true });

  // Own connection dedicated to /healthz — deliberately not the session
  // plugin's internal client (packages/auth doesn't expose it), and cheap
  // enough that a second connection is simpler than plumbing one through.
  const healthzRedis = new Redis(opts.redisUrl, { lazyConnect: true });
  app.addHook('onClose', async () => {
    await healthzRedis.quit().catch(() => {});
  });

  app.register(errorEnvelopePlugin);

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
  app.get('/healthz', async (request, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      opts.db
        .execute(sql`select 1`)
        .then(() => true)
        .catch(() => false),
      healthzRedis
        .ping()
        .then(() => true)
        .catch(() => false),
    ]);
    if (!dbOk || !redisOk) {
      return sendProblem(request, reply, 503, 'Service Unavailable', {
        detail: `postgres=${dbOk ? 'ok' : 'down'} redis=${redisOk ? 'ok' : 'down'}`,
      });
    }
    return reply.send({ status: 'ok' });
  });

  // Also unauthenticated: contract-testing tools (schemathesis, API_DESIGN.md
  // §5) need the spec before they can authenticate, and it carries no
  // tenant data — judgment call, not in the doc's literal exemption list;
  // documented in plan.json W1-04 notes.
  app.get('/api/v1/openapi.json', async () => app.swagger());

  app.register(apiV1, { db: opts.db, prefix: '/api/v1' });

  return app;
}
