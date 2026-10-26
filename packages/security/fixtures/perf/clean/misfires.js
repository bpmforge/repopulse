// Near-misses from the W21-20 hand-check: each shape below was marked wrong
// on real code, and no performance rule may fire on it.

// Synchronous methods that share a query's name (bpm-perf-orm-call-in-loop).
export function digest(hash, chunks, fields, row) {
  const values = [];
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  for (const field of fields) {
    values.push(Reflect.get(row, field));
  }
  return values;
}

// Numeric accumulators, whatever they are called (bpm-perf-string-concat-in-loop).
export function totals(streams) {
  let unreadMessages = 0;
  let textLength = 0;
  const result = { skipped: 0 };
  for (const s of streams) {
    unreadMessages += s.unmutedCount;
    textLength += s.text.length || 0;
    result.skipped += 1;
  }
  return unreadMessages + textLength + result.skipped;
}

// Doubling is the O(log n) way to repeat a string.
export function repeat(str, count) {
  let out = '';
  let buf = str;
  while (count > 0) {
    if (count & 1) out = out.concat(buf);
    count >>= 1;
    if (count) buf += buf;
  }
  return out;
}

// Each group already runs its handlers concurrently (bpm-perf-await-in-loop).
export async function shutdown(groups) {
  for (const handlers of groups) {
    await Promise.allSettled(handlers.map((h) => h()));
  }
}
