import type { Redis } from 'ioredis';
import type { Session } from 'fastify';
import './types.js';

// @fastify/session's SessionStore shape (express-session-compatible):
// set(sessionId, session, cb) / get(sessionId, cb) / destroy(sessionId, cb).
// Callback signatures match its CallbackSession/Callback types exactly
// (verified against the installed @fastify/session 11.1.2 .d.ts) so this
// class structurally satisfies `store?: fastifySession.SessionStore`.
type StoreCallback = (err?: Error | null) => void;
type GetCallback = (err: Error | null, session?: Session | null) => void;

export interface RedisSessionStoreOptions {
  redis: Redis;
  /** FR-AUTH-2 absolute lifetime cap, independent of the idle-timeout TTL below. */
  absoluteLifetimeMs: number;
  keyPrefix?: string;
}

// FR-AUTH-2: idle timeout + absolute lifetime. @fastify/session's default
// `rolling: true` re-derives session.cookie.originalMaxAge on every request
// (packages/auth verified against the installed @fastify/session 11.1.2
// source: lib/session.js Session constructor + lib/cookie.js), and calls
// store.set() on every response — so applying originalMaxAge as this key's
// Redis TTL on every set() gives a sliding idle timeout for free. Absolute
// lifetime has no equivalent in the library; enforced here by stamping
// `createdAt` once at login (packages/auth/src/session/plugin.ts) and
// rejecting on get() once that age is exceeded, regardless of the Redis
// TTL still being live.
export class RedisSessionStore {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly absoluteLifetimeMs: number;

  constructor(opts: RedisSessionStoreOptions) {
    this.redis = opts.redis;
    this.keyPrefix = opts.keyPrefix ?? 'sess:';
    this.absoluteLifetimeMs = opts.absoluteLifetimeMs;
  }

  private key(sessionId: string): string {
    return `${this.keyPrefix}${sessionId}`;
  }

  set(sessionId: string, session: Session, callback: StoreCallback): void {
    const ttlMs = session.cookie?.originalMaxAge;
    const payload = JSON.stringify(session);
    const op =
      typeof ttlMs === 'number' && ttlMs > 0
        ? this.redis.set(this.key(sessionId), payload, 'PX', ttlMs)
        : this.redis.set(this.key(sessionId), payload);
    op.then(
      () => callback(),
      (err: unknown) => callback(err as Error),
    );
  }

  get(sessionId: string, callback: GetCallback): void {
    this.redis.get(this.key(sessionId)).then(
      (raw: string | null) => {
        if (!raw) {
          callback(null, null);
          return;
        }
        const session = JSON.parse(raw) as Session;
        if (
          typeof session.createdAt === 'number' &&
          Date.now() - session.createdAt > this.absoluteLifetimeMs
        ) {
          this.redis.del(this.key(sessionId)).catch(() => {});
          callback(null, null);
          return;
        }
        callback(null, session);
      },
      (err: unknown) => callback(err as Error),
    );
  }

  destroy(sessionId: string, callback: StoreCallback): void {
    this.redis.del(this.key(sessionId)).then(
      () => callback(),
      (err: unknown) => callback(err as Error),
    );
  }
}
