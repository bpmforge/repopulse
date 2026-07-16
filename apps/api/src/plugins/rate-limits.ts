import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';

// SC-11 named limits, applied per-route via `config: { rateLimit: ... }`
// (verified against @fastify/rate-limit 11.1.0: `global: false` here means
// NO route is limited unless it opts in with its own `config.rateLimit`,
// so registering this plugin has zero effect on unrelated routes).
//
// Only AUTH_FLOW_RATE_LIMIT is wired to a real route today (routes/auth's
// /auth/login + /auth/callback - the only routes that exist). WEBHOOK_ and
// SHARE_SLUG_RATE_LIMIT are exported now so the webhook (ingest wave) and
// share-slug (reports wave) route tickets apply them directly instead of
// re-deriving the SC-11 numbers; SSE-connections-per-session has no
// @fastify/rate-limit equivalent (it isn't a request-rate limit) and is
// left for whichever ticket adds SSE routes to implement as a connection
// counter.
export const AUTH_FLOW_RATE_LIMIT: RateLimitOptions = { max: 10, timeWindow: '1 minute' };
export const WEBHOOK_RATE_LIMIT: RateLimitOptions = { max: 100, timeWindow: '1 minute' };
export const SHARE_SLUG_RATE_LIMIT: RateLimitOptions = { max: 60, timeWindow: '1 minute' };

async function rateLimits(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, { global: false });
}

export default fp(rateLimits, { name: '@repopulse/api-rate-limits' });
