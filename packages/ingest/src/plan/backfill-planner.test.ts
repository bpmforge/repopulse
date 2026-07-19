import { describe, expect, it } from 'vitest';
import { BACKFILL_WINDOW_DAYS, ENTITY_ORDER, planBackfill } from './backfill-planner.js';

const NOW = Date.parse('2026-07-18T00:00:00Z');

describe('backfill planner (INGESTION §3, FR-INGEST-2/3/4)', () => {
  it('orders repos pushedAt desc, then entities in the §3 order per repo', () => {
    const specs = planBackfill(
      [
        { repoId: 1, pushedAt: '2026-01-01T00:00:00Z' },
        { repoId: 2, pushedAt: '2026-07-01T00:00:00Z' }, // most recent → first
        { repoId: 3, pushedAt: null }, // never pushed → last
      ],
      NOW,
    );
    // repo 2 first, its entities in canonical order
    expect(specs.slice(0, ENTITY_ORDER.length).map((s) => s.repoId)).toEqual(
      ENTITY_ORDER.map(() => 2),
    );
    expect(specs.slice(0, ENTITY_ORDER.length).map((s) => s.entityType)).toEqual([...ENTITY_ORDER]);
    // repo order overall: 2, 1, 3
    const firstEntityPerRepo = specs.filter((s) => s.entityType === 'prs').map((s) => s.repoId);
    expect(firstEntityPerRepo).toEqual([2, 1, 3]);
  });

  it('PRs come before commits before checks before issues before releases/deployments', () => {
    const specs = planBackfill([{ repoId: 9, pushedAt: '2026-01-01T00:00:00Z' }], NOW);
    expect(specs.map((s) => s.entityType)).toEqual([
      'prs',
      'commits',
      'checks',
      'issues',
      'releases',
      'deployments',
    ]);
  });

  it('sets the since boundary to exactly now−365d and stamps idempotent jobIds', () => {
    const specs = planBackfill([{ repoId: 7, pushedAt: '2026-07-01T00:00:00Z' }], NOW);
    const expectedSince = new Date(NOW - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(specs[0]?.since).toBe(expectedSince);
    expect(specs[0]?.jobId).toBe('bf:7:prs');
    expect(specs[1]?.jobId).toBe('bf:7:commits');
  });

  it('is deterministic for equal pushedAt (repoId tie-break)', () => {
    const specs = planBackfill(
      [
        { repoId: 5, pushedAt: '2026-01-01T00:00:00Z' },
        { repoId: 2, pushedAt: '2026-01-01T00:00:00Z' },
      ],
      NOW,
    );
    expect(specs.filter((s) => s.entityType === 'prs').map((s) => s.repoId)).toEqual([2, 5]);
  });
});
