import { describe, expect, it } from 'vitest';
import { prSizeBucket } from '@repopulse/metrics';
import { SIZE_BUCKET_BOUNDS, decodeCursor, encodeCursor, orgListQuery } from './index.js';

// W4-16. The bucket bounds in routes/prs/index.ts are SQL ranges rather than a
// per-row prSizeBucket() call, because the filter has to run inside the
// paginated query — filtering afterwards returns short pages. Two definitions
// of the same thing is a divergence waiting to happen, so this pins them to
// each other at every boundary rather than trusting that they match.

// The PRODUCTION constant, imported rather than restated. A copy here would
// agree with itself forever and pin nothing.
const BOUNDS = SIZE_BUCKET_BOUNDS;

describe('org PR list size-bucket bounds (METRICS.md §1 M7)', () => {
  it('every bound agrees with prSizeBucket at its own edges', () => {
    for (const [bucket, { min, max }] of Object.entries(BOUNDS)) {
      // The minimum is INSIDE the bucket…
      expect(prSizeBucket(min), `${bucket} min`).toBe(bucket);
      if (max !== null) {
        // …the value just below the maximum is too…
        expect(prSizeBucket(max - 1), `${bucket} max-1`).toBe(bucket);
        // …and the maximum itself belongs to the NEXT bucket. An inclusive
        // upper bound here would put a 100-line PR in both S and M, so it would
        // appear twice in an unfiltered page and never in a filtered one.
        expect(prSizeBucket(max), `${bucket} max`).not.toBe(bucket);
      }
    }
  });

  it('the ranges are contiguous and cover every size', () => {
    const ordered = ['XS', 'S', 'M', 'L', 'XL'];
    for (let i = 1; i < ordered.length; i++) {
      const prev = BOUNDS[ordered[i - 1]!]!;
      const curr = BOUNDS[ordered[i]!]!;
      // A gap would make PRs of that size invisible to EVERY bucket filter —
      // an empty result that looks like "no PRs this size" rather than a bug.
      expect(prev.max, `${ordered[i - 1]} → ${ordered[i]}`).toBe(curr.min);
    }
    expect(BOUNDS.XS!.min).toBe(0);
    expect(BOUNDS.XL!.max).toBeNull();
  });
});

// The cursor is `${updatedAtMs}:${id}` — keyset, not offset, because the list
// is ordered by updated_at and that value CHANGES while a user pages through
// it. An offset would skip or repeat rows every time a PR was touched
// mid-scroll, which presents as "the list is missing PRs" and is unreproducible.
describe('org PR list cursor', () => {
  const encode = encodeCursor;
  const decode = decodeCursor;

  it('round-trips a timestamp and id exactly', () => {
    const at = new Date('2026-08-15T12:34:56.789Z');
    const decoded = decode(encode(at, 4242));
    expect(decoded?.updatedAt.toISOString()).toBe(at.toISOString());
    expect(decoded?.id).toBe(4242);
  });

  it('rejects a malformed cursor instead of silently starting from the top', () => {
    // A cursor that decodes to garbage must 400. Coercing it to "no cursor"
    // would restart the list at page one, so a client paging forward would loop
    // over the first page forever without any error to explain why.
    expect(decode('not-a-cursor')).toBeNull();
    expect(decode('123:abc')).toBeNull();
  });
});

// W20-05 (UX_TODO DSH-13). The topbar's repository filter is multi-select and
// sends a CSV; this parsed it as ONE integer, so two repositories were a 400.
describe('org PR list repo filter', () => {
  it('accepts one id or a CSV of ids', () => {
    expect(orgListQuery.parse({ repo_id: '7' }).repo_id).toEqual([7]);
    expect(orgListQuery.parse({ repo_id: '7,9,12' }).repo_id).toEqual([7, 9, 12]);
  });

  it('rejects anything that is not a list of ids', () => {
    expect(orgListQuery.safeParse({ repo_id: '7,abc' }).success).toBe(false);
    expect(orgListQuery.safeParse({ repo_id: 'all' }).success).toBe(false);
  });
});

// W20-20 (UX_TODO DSH-45): the list sorts by update or by age.
describe('org PR list sort', () => {
  it('accepts the four sorts and nothing else', () => {
    for (const sort of ['updated:desc', 'updated:asc', 'opened:desc', 'opened:asc']) {
      expect(orgListQuery.parse({ sort }).sort).toBe(sort);
    }
    expect(orgListQuery.safeParse({ sort: 'title:asc' }).success).toBe(false);
  });
});
