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
/** Whose session this is: the signed-in user, or the one pending a password change. */
function ownerOf(session: Session): number | undefined {
  const s = session as Session & { pendingPasswordChangeUserId?: unknown };
  if (typeof s.userId === 'number') return s.userId;
  return typeof s.pendingPasswordChangeUserId === 'number'
    ? s.pendingPasswordChangeUserId
    : undefined;
}

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

  /**
   * The per-user index (W20-10, UX_TODO ADM-78): the ids of every session a
   * user holds. Sessions were keyed by id alone, so nothing could find "every
   * session of user 7" — a password change left every other device signed in.
   */
  private userKey(userId: number): string {
    return `${this.keyPrefix}user:${userId}`;
  }

  set(sessionId: string, session: Session, callback: StoreCallback): void {
    const ttlMs = session.cookie?.originalMaxAge;
    const payload = JSON.stringify(session);
    const multi = this.redis.multi();
    if (typeof ttlMs === 'number' && ttlMs > 0) {
      multi.set(this.key(sessionId), payload, 'PX', ttlMs);
    } else {
      multi.set(this.key(sessionId), payload);
    }
    // A session pending its forced password change is indexed too: an admin
    // reset must be able to end it as well.
    const owner = ownerOf(session);
    if (owner !== undefined) {
      multi.sadd(this.userKey(owner), sessionId);
      // Nothing in the set can outlive the absolute lifetime, so neither does
      // the set; refreshed on every save, so it lasts as long as its newest.
      multi.pexpire(this.userKey(owner), this.absoluteLifetimeMs);
    }
    multi.exec().then(
      (results) => {
        const failed = results?.find(([err]) => err !== null)?.[0];
        if (failed) callback(failed);
        else callback();
      },
      (err: unknown) => callback(err as Error),
    );
  }

  /**
   * Ends every session `userId` holds except `keepSessionId` (W20-10, UX_TODO
   * ADM-78) — "Sign out everywhere", and what a password change or an admin
   * reset does so whoever knew the old password is locked out. Returns how
   * many live sessions were ended. Ids in the index whose session already
   * expired cost a DEL that finds nothing, and are dropped from the index.
   */
  async destroyUserSessions(userId: number, keepSessionId?: string): Promise<number> {
    const ids = await this.redis.smembers(this.userKey(userId));
    const doomed = ids.filter((id) => id !== keepSessionId);
    if (doomed.length === 0) return 0;
    const ended = await this.redis.del(...doomed.map((id) => this.key(id)));
    await this.redis.srem(this.userKey(userId), ...doomed);
    return ended;
  }

  /** Live sessions `userId` holds right now (expired ids are skipped). */
  async countUserSessions(userId: number): Promise<number> {
    const ids = await this.redis.smembers(this.userKey(userId));
    if (ids.length === 0) return 0;
    return this.redis.exists(...ids.map((id) => this.key(id)));
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
