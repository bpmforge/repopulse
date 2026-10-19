// Augments @fastify/session's ambient `Session` interface (see its README's
// TypeScript section) with the fields this package actually stores.
declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The session store (W20-10, UX_TODO ADM-78), decorated by sessionPlugin.
     * Optional because route plugins are also mounted in tests without it.
     */
    sessionStore?: import('./redis-store.js').RedisSessionStore;
  }
  interface Session {
    userId?: number;
    /** Login time in epoch ms — absolute-lifetime basis (FR-AUTH-2, RedisSessionStore). */
    createdAt?: number;
  }
}

export {};
