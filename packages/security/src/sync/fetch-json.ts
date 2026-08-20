// The only outbound HTTP in packages/security (W10-02, FR-REG-2/3).
//
// It lives here, in the WORKER lane, and never inside a scanner: the scan
// container runs with `--network=none` and that is not a detail to be worked
// around. Every register reads rows this job wrote; none of them can reach the
// internet even if a future edit tried.
//
// Injectable because the tests must not depend on npm or endoflife.date being
// reachable — but the field mappings were written against the LIVE payloads
// (Law 2), and the fixtures in the tests are captured responses, not invented
// ones.

export type JsonFetcher = (url: string) => Promise<unknown>;

export interface FetchJsonOptions {
  timeoutMs?: number;
  userAgent?: string;
}

export class SyncFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SyncFetchError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A GET returning parsed JSON, or a thrown SyncFetchError.
 *
 * THROWS rather than returning null on a bad status: a sync that quietly
 * skipped half its packages would leave the register looking at stale rows and
 * reporting them as current, which is worse than a failed job.
 */
export function jsonFetcher(options: FetchJsonOptions = {}): JsonFetcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? 'RepoPulse/1.0 (dependency-health sync)';

  return async (url: string): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': userAgent },
      });
      if (!response.ok) {
        throw new SyncFetchError(`${response.status} from ${url}`, url, response.status);
      }
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof SyncFetchError) throw error;
      throw new SyncFetchError(
        error instanceof Error ? error.message : String(error),
        url,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
