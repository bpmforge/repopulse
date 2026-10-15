// Retry and backoff loops: sequential on purpose, so neither
// bpm-perf-await-in-loop nor bpm-ch-try-catch-in-loop may fire here.
declare function sleep(ms: number): Promise<void>;
declare function delay(ms: number): Promise<void>;

export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 100 * 2 ** i));
    }
  }
  throw lastError;
}

export async function connect(open: () => Promise<void>, max: number): Promise<void> {
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      await open();
      break;
    } catch (err) {
      if (attempt === max) throw err;
    }
  }
}

export async function untilUp(op: () => Promise<void>): Promise<void> {
  let backoff = 100;
  while (true) {
    try {
      await op();
      return;
    } catch {
      await delay(backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  }
}

export async function poll(url: string): Promise<Response> {
  for (;;) {
    const res = await fetch(url);
    if (res.ok) return res;
    await sleep(1000);
  }
}
