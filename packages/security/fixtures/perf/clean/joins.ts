// The same jobs done in linear time, and the look-alikes that are not
// quadratic. None of these may fire (W21-20).

interface Review { pullRequestId: number; state: string }
interface Comment { pullRequestId: number; path: string }
interface Pr { id: number; repoId: number; state: string }

const CLOSING = ['merged', 'closed'];
const SIZE_BUCKETS = ['S', 'M', 'L'];

// The fix: index once, then O(1) lookups.
export function commentsPerDismissed(reviews: Review[], comments: Comment[]): number {
  const byPr = new Map<number, Comment[]>();
  for (const c of comments) {
    const bucket = byPr.get(c.pullRequestId);
    if (bucket) bucket.push(c);
    else byPr.set(c.pullRequestId, [c]);
  }
  let n = 0;
  for (const r of reviews) n += (byPr.get(r.pullRequestId) ?? []).length;
  return n;
}

export function inScope(prs: Pr[], repoIds: number[]): Pr[] {
  const wanted = new Set(repoIds);
  return prs.filter((p) => wanted.has(p.repoId));
}

// A fixed constant list is bounded: membership in it is O(1) in practice.
export function closed(prs: Pr[]): Pr[] {
  return prs.filter((p) => CLOSING.includes(p.state));
}

// A constant OUTER list: a few linear passes, not a join.
export function sizeCounts(prs: Pr[]): number[] {
  return SIZE_BUCKETS.map((bucket) => prs.filter((p) => p.state === bucket).length);
}

// A string, not an array: substring search, nothing to index.
export function mentions(lines: string[], needles: string[]): string[] {
  return lines.filter((line) => needles.some((n) => line.toLowerCase().includes(n.toLowerCase())));
}

// The same collection's own predicate is one pass, not two.
export function open(prs: Pr[]): Pr[] {
  return prs.filter((p) => p.state === 'open');
}

// Grouping by pushing into the bucket: linear.
export function groupByRepo(prs: Pr[]): Map<number, Pr[]> {
  const byRepo = new Map<number, Pr[]>();
  for (const p of prs) {
    const bucket = byRepo.get(p.repoId);
    if (bucket) bucket.push(p);
    else byRepo.set(p.repoId, [p]);
  }
  return byRepo;
}

// Map/Set bookkeeping in a loop is not a database call (bpm-perf-orm-call-in-loop
// once reported every one-argument .get / .delete; W21-20).
export function pending(prs: Pr[], done: Set<number>): number {
  const left = new Map<number, Pr>(prs.map((p) => [p.id, p]));
  for (const id of done) {
    if (left.get(id)) left.delete(id);
  }
  return left.size;
}
