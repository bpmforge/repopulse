export interface RatioResult {
  numerator: number;
  denominator: number;
  /** METRICS.md §0: empty denominator -> null ("no data"), never 0 or 100. */
  value: number | null;
}

// METRICS.md §0: keep numerator/denominator in snapshots (FR-METRICS-13) so
// org rollups can sum them directly rather than averaging pre-computed
// ratios (FR-METRICS-14).
export function ratio(numerator: number, denominator: number): RatioResult {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}
