import { hostname } from 'node:os';
import type { Redis } from 'ioredis';

// Worker heartbeat (W17-06).
//
// WHY /healthz IS NOT ENOUGH. The worker's /healthz answers "this process can
// reach Postgres and Redis". It says nothing about whether a queue consumer is
// alive — a worker whose BullMQ consumers never registered, or died, answers 200
// forever. And nothing outside the container can call it at all: the API has no
// route to the worker's port, so from the product's point of view a dead worker
// and a busy one are indistinguishable.
//
// So each worker INSTANCE writes a short-lived key to Redis, which both sides
// already share. Presence of the key is the liveness signal, and its TTL does
// the expiry — no reaper, no clock comparison at the reader, and no way for a
// worker that was SIGKILLed to leave a permanent "I am alive" behind.
//
// Per INSTANCE, deliberately: a single shared key would mean one worker
// stopping erases the evidence that the other three are running.
//
// Contains no secrets and no repository content — an id, timestamps, a pid and
// the queue names this instance consumes. It is read by an admin endpoint and
// must stay safe to show.

/** Key prefix. A colon namespace so a SCAN can find every instance. */
export const HEARTBEAT_PREFIX = 'repopulse:worker:heartbeat:';

/**
 * Refresh interval. Comfortably inside the TTL so a single slow write, or one
 * missed tick during a long job, does not make a healthy worker vanish.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * How long a heartbeat survives without a refresh. Three intervals: a worker
 * has to miss three in a row before it is reported gone, and a stopped worker
 * disappears within a minute.
 */
export const HEARTBEAT_TTL_SECONDS = 60;

export interface WorkerHeartbeat {
  /** Unique per process, so restarts and replicas are distinguishable. */
  instanceId: string;
  /** ISO. When this process's consumers came up. */
  startedAt: string;
  /** ISO. Written on every refresh. */
  lastBeatAt: string;
  pid: number;
  host: string;
  /** Queue names this instance actually consumes. */
  queues: string[];
  /**
   * W20-16 (UX_TODO AI-73/74). What THIS worker finds when it looks for the
   * customer-supplied Claude Code CLI — the container that actually runs it.
   * The api container's own check could only speak for the api, which the
   * documented overlay used not to give the CLI. Absent from older workers.
   */
  claudeCli?: WorkerCliStatus;
}

/** The worker's view of the Claude Code CLI. No login detail beyond the boolean. */
export interface WorkerCliStatus {
  found: boolean;
  version: string | null;
  reportsLoggedIn: boolean | null;
  reason: string | null;
  /** ISO. When the worker last looked. */
  checkedAt: string;
}

export interface HeartbeatHandle {
  instanceId: string;
  /** Write one beat now. Exposed so a test need not wait for the timer. */
  beat: () => Promise<void>;
  /** Stop refreshing AND remove the key, so shutdown is visible immediately. */
  stop: () => Promise<void>;
}

export interface StartHeartbeatOptions {
  redis: Redis;
  /** Queue names this instance consumes. */
  queues: string[];
  instanceId?: string;
  intervalMs?: number;
  ttlSeconds?: number;
  /** Reported rather than thrown: a failed beat must not kill the worker. */
  onError?: (err: unknown) => void;
  /** The latest Claude Code CLI check, read on every beat (W20-16). */
  claudeCli?: () => WorkerCliStatus | undefined;
}

/**
 * Begin publishing this instance's heartbeat.
 *
 * Call AFTER the consumers are registered — the point of the signal is that
 * work can be picked up, and a heartbeat written before the consumers exist
 * would assert something untrue for the length of the startup.
 */
export function startWorkerHeartbeat(opts: StartHeartbeatOptions): HeartbeatHandle {
  const instanceId =
    opts.instanceId ?? `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `${HEARTBEAT_PREFIX}${instanceId}`;
  const ttl = opts.ttlSeconds ?? HEARTBEAT_TTL_SECONDS;
  const startedAt = new Date().toISOString();
  let stopped = false;

  const beat = async (): Promise<void> => {
    if (stopped) return;
    const payload: WorkerHeartbeat = {
      instanceId,
      startedAt,
      lastBeatAt: new Date().toISOString(),
      pid: process.pid,
      host: hostname(),
      queues: opts.queues,
    };
    const cli = opts.claudeCli?.();
    if (cli) payload.claudeCli = cli;
    try {
      // SET with EX rather than SET then EXPIRE: one round trip, and no window
      // in which the key exists without a TTL. A key that lost its TTL would
      // report a dead worker as alive forever.
      await opts.redis.set(key, JSON.stringify(payload), 'EX', ttl);
    } catch (err) {
      // A worker that cannot reach Redis has bigger problems, and its heartbeat
      // expiring IS the correct signal. Never let this throw into the timer.
      opts.onError?.(err);
    }
  };

  const timer = setInterval(() => void beat(), opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  // Do not hold the event loop open on the heartbeat alone.
  timer.unref?.();

  void beat();

  return {
    instanceId,
    beat,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // Delete rather than wait out the TTL: a clean shutdown should be visible
      // in the UI immediately, not up to 60 seconds later.
      try {
        await opts.redis.del(key);
      } catch (err) {
        opts.onError?.(err);
      }
    },
  };
}

/**
 * Every live worker instance, newest beat first.
 *
 * SCAN rather than KEYS: KEYS blocks the server for the length of the keyspace,
 * and this runs behind an admin endpoint that may be polled.
 */
export async function readWorkerHeartbeats(redis: Redis): Promise<WorkerHeartbeat[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${HEARTBEAT_PREFIX}*`, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
    // A keyspace pathologically full of heartbeat keys should not make an admin
    // page hang; far more than any real deployment has.
  } while (cursor !== '0' && keys.length < 1000);

  if (keys.length === 0) return [];

  const values = await redis.mget(...keys);
  const out: WorkerHeartbeat[] = [];
  for (const raw of values) {
    if (!raw) continue; // expired between the SCAN and the MGET
    try {
      out.push(JSON.parse(raw) as WorkerHeartbeat);
    } catch {
      // A malformed value is not worth failing an admin page over.
    }
  }
  return out.sort((a, b) => b.lastBeatAt.localeCompare(a.lastBeatAt));
}
