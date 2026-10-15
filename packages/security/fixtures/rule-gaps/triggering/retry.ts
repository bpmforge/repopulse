// Loops that look like retries but are not: no early exit on success, or no
// bound and no backoff. Both rules keep firing on these.
declare function save(x: string): Promise<void>;
declare function log(e: unknown): Promise<void>;
declare function sleep(ms: number): Promise<void>;
declare function lookup(id: string): Promise<{ match: boolean }>;

export async function saveAll(xs: string[]): Promise<void> {
  for (const x of xs) {
    try {
      await save(x);
    } catch (e) {
      await log(e);
    }
  }
}

export async function paced(jobs: Array<() => Promise<void>>): Promise<void> {
  for (const job of jobs) {
    try {
      await job();
    } catch {
      await sleep(10);
    }
  }
}

export async function firstMatch(ids: string[]): Promise<string | undefined> {
  for (let i = 0; i < ids.length; i++) {
    const row = await lookup(ids[i]!);
    if (row.match) return ids[i];
  }
  return undefined;
}
