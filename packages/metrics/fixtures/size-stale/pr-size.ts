import type { PrSizeInput } from '../../src/metrics/pr-size.js';

// METRICS.md §1 M7 bucket boundaries: XS[0,10) S[10,100) M[100,500)
// L[500,1000) XL[1000,inf), inclusive-lower/exclusive-upper. One PR at
// every boundary value, split across additions/deletions arbitrarily to
// prove `gross` (not additions alone) drives the bucket.
export const PR_SIZE_BOUNDARY_FIXTURE: readonly PrSizeInput[] = [
  { additions: 0, deletions: 0 }, // gross 0 -> XS
  { additions: 5, deletions: 4 }, // gross 9 -> XS (upper edge)
  { additions: 6, deletions: 4 }, // gross 10 -> S (lower edge)
  { additions: 60, deletions: 39 }, // gross 99 -> S (upper edge)
  { additions: 60, deletions: 40 }, // gross 100 -> M (lower edge)
  { additions: 300, deletions: 199 }, // gross 499 -> M (upper edge)
  { additions: 300, deletions: 200 }, // gross 500 -> L (lower edge)
  { additions: 600, deletions: 399 }, // gross 999 -> L (upper edge)
  { additions: 600, deletions: 400 }, // gross 1000 -> XL (lower edge)
  { additions: 30_000, deletions: 20_000 }, // gross 50000 -> XL
];
