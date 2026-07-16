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
    await redis.quit();
  });
}

export default fp(sessionPlugin, { name: '@repopulse/auth-session' });
