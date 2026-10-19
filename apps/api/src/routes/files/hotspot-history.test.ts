import { describe, expect, it } from 'vitest';
import { fileHotspotHistory } from './hotspot-history.js';

describe('fileHotspotHistory (W20-13)', () => {
  const at = (d: number) => new Date(Date.UTC(2026, 9, d + 1));
  const rows = [
    {
      computedAt: at(3),
      dims: {
        files: [
          { path: 'top.ts', score: 0.9 },
          { path: 'a.ts', score: 0.4 },
        ],
      },
    },
    { computedAt: at(2), dims: { count: 3 } },
    { computedAt: at(1), dims: { files: [{ path: 'top.ts', score: 0.8 }] } },
    { computedAt: at(0), dims: { files: [{ path: 'a.ts', score: 0.1 }] } },
  ];

  it("keeps only the viewed file's points, newest first", () => {
    expect(fileHotspotHistory(rows, 'a.ts')).toEqual([
      { computed_at: at(3).toISOString(), score: 0.4 },
      { computed_at: at(0).toISOString(), score: 0.1 },
    ]);
  });

  it("never borrows another file's score", () => {
    expect(fileHotspotHistory(rows, 'never.ts')).toEqual([]);
  });
});
