import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { RedisSessionStore } from './redis-store.js';
import './types.js';

export interface SessionPluginOptions {
  redisUrl: string;
  /** Must be >=32 chars — @fastify/session rejects shorter secrets. */
  sessionSecret: string;
  /** FR-AUTH-2 idle timeout; renewed on every request (rolling, library default). */
  idleTimeoutMs: number;
  /** FR-AUTH-2 absolute lifetime, enforced independently in RedisSessionStore. */
  absoluteLifetimeMs: number;
  /**
   * Cookie `Secure` flag. Must be false over dev/test http://localhost —
   * browsers silently drop `Secure` cookies on non-TLS origins, which would
   * make every "authenticated" request in local dev/E2E fail mysteriously.
   */
  cookieSecure: boolean;
}

async function sessionPlugin(app: FastifyInstance, opts: SessionPluginOptions): Promise<void> {
  const redis = new Redis(opts.redisUrl);

  // Route transport faults to the app logger instead of leaving them unhandled
  // (W17-03). ioredis emits `error` on its client and, with no listener,
  // console.errors "[ioredis] Unhandled error event" itself — which is exactly
  // what W16-34 kept catching as `write EPIPE` when a full suite ran against a
  // contended data tier. This was the only Redis client in the codebase with
  // neither a listener nor a guarded shutdown; routes/health and routes/events
  // already handled theirs.
  //
  // Logged, NOT swallowed: ioredis reconnects on its own, so a genuine
  // connection fault still has to be visible in production, and a silent
  // `.catch(() => {})` here would hide a Redis outage behind broken sessions.
  redis.on('error', (err: Error) => {
    app.log.warn({ err }, 'session redis connection error');
  });
  const store = new RedisSessionStore({ redis, absoluteLifetimeMs: opts.absoluteLifetimeMs });

  await app.register(fastifyCookie, { secret: opts.sessionSecret });
  await app.register(fastifySession, {
    secret: opts.sessionSecret,
    store,
    cookieName: 'repopulse_sid',
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: opts.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: opts.idleTimeoutMs,
    },
  });

  app.addHook('onClose', async () => {
    // A socket that is already gone has nothing left to quit gracefully, and a
    // rejecting onClose fails teardown for every suite that builds an app.
    await redis.quit().catch(() => redis.disconnect());
  });
}

export default fp(sessionPlugin, { name: '@repopulse/auth-session' });
