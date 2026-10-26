// Algorithmic shapes (W21-20). Each is linear in one collection per element of
// another, so the whole thing is O(n·m), or O(k²) for the copy-on-append.

interface Review { pullRequestId: number; state: string }
interface Comment { pullRequestId: number; path: string }
interface Pr { id: number; repoId: number }

// find-by-key: a join done by scanning the inner list per outer row.
export function commentsPerDismissed(reviews: Review[], comments: Comment[]): number {
  let n = 0;
  for (const r of reviews) {
    const mine = comments.filter((c) => c.pullRequestId === r.pullRequestId);
    n += mine.length;
  }
  return n;
}

export function rowFor(repoIds: number[], rows: Pr[]): (Pr | undefined)[] {
  return repoIds.map((repoId) => rows.find((r) => r.repoId === repoId));
}

// includes: membership tested against an array per element.
export function inScope(prs: Pr[], repoIds: number[]): Pr[] {
  return prs.filter((p) => repoIds.includes(p.repoId));
}

// copy-on-append: the group is copied on every insert.
export function groupByRepo(prs: Pr[]): Map<number, Pr[]> {
  const byRepo = new Map<number, Pr[]>();
  for (const p of prs) byRepo.set(p.repoId, [...(byRepo.get(p.repoId) ?? []), p]);
  return byRepo;
}

export function indexById(prs: Pr[]): Record<number, Pr> {
  return prs.reduce((acc, p) => ({ ...acc, [p.id]: p }), {} as Record<number, Pr>);
}
