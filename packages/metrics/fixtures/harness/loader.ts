import { E1_HOTSPOT_FIXTURE, type HotspotFixture } from './e1-hotspot.js';
import { E2_CYCLE_STAGES_FIXTURE, type CycleStagesFixture } from './e2-cycle-stages.js';
import { E3_REVIEW_COVERAGE_FIXTURE, type ReviewCoverageFixturePr } from './e3-review-coverage.js';

// METRICS.md §4 worked-example fixtures, shared with every metric ticket
// (W3-02+) that needs a known-good input/output pair to test against -
// loaded once here so no ticket re-derives or re-transcribes the doc's
// example numbers.
export function loadHotspotFixture(): HotspotFixture {
  return E1_HOTSPOT_FIXTURE;
}

export function loadCycleStagesFixture(): CycleStagesFixture {
  return E2_CYCLE_STAGES_FIXTURE;
}

export function loadReviewCoverageFixture(): readonly ReviewCoverageFixturePr[] {
  return E3_REVIEW_COVERAGE_FIXTURE;
}
