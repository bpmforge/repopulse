// METRICS.md §4 E1 — M2 hotspot worked example (repo "demo", W=30d,
// today=2026-07-07). Consumed by whichever ticket implements M2 (W3-02);
// this harness only guarantees the raw inputs load with the documented
// values - it does not compute hotspot() itself (out of W3-01's scope).
export interface HotspotFixtureTouch {
  path: string;
  additions: number;
  deletions: number;
  committedAt: string; // ISO 8601
}

export interface HotspotFixture {
  repo: string;
  today: string; // ISO 8601 - the "as of" date decay() measures against
  windowDays: number;
  touches: readonly HotspotFixtureTouch[];
}

export const E1_HOTSPOT_FIXTURE: HotspotFixture = {
  repo: 'demo',
  today: '2026-07-07T00:00:00Z',
  windowDays: 30,
  touches: [
    { path: 'api.ts', additions: 120, deletions: 40, committedAt: '2026-07-05T00:00:00Z' },
    { path: 'util.ts', additions: 20, deletions: 10, committedAt: '2026-06-10T00:00:00Z' },
  ],
};

// Expected derived values per METRICS.md §4 E1, for downstream tickets to
// assert against once M2 is implemented (gross=160/30, normChurn=1.0/0.1875,
// daysSince=2/27, decay=0.955/0.536 approx, hotspot=0.955/0.100 approx).
export const E1_EXPECTED = {
  gross: { 'api.ts': 160, 'util.ts': 30 },
  normChurn: { 'api.ts': 1.0, 'util.ts': 0.1875 },
  daysSince: { 'api.ts': 2, 'util.ts': 27 },
  decay: { 'api.ts': 0.955, 'util.ts': 0.536 },
  hotspot: { 'api.ts': 0.955, 'util.ts': 0.1 },
} as const;
