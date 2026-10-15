// Exponential backoff with full jitter: the delay is uniform in [0, cap) so
// many clients retrying together do not stay in lockstep.
export function backoffMs(attempt: number, baseMs = 100, maxMs = 10_000): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}

export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, backoffMs(i)));
    }
  }
  throw lastError;
}
