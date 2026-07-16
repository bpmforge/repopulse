// Augments @fastify/session's ambient `Session` interface (see its README's
// TypeScript section) with the fields this package actually stores.
declare module 'fastify' {
  interface Session {
    userId?: number;
    /** Login time in epoch ms — absolute-lifetime basis (FR-AUTH-2, RedisSessionStore). */
    createdAt?: number;
  }
}

export {};
