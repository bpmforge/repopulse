import accuracy from './release-accuracy.json';

// This release's published accuracy (W20-23, UX_TODO X-11; W20_DECISIONS_2
// row 8: an About page any signed-in user can open).
//
// The numbers live in a checked-in file, release-accuracy.json, copied from
// the committed benchmark report (docs/benchmarks/report.json, method in
// docs/BENCHMARKS.md). Nothing here is computed or rounded again: each row
// names the report section it was copied from, and accuracy.test.ts fails
// when a number no longer matches the report or the release no longer
// matches this package's version. Re-running the benchmark for a release
// means updating both files in the same change.

export interface AccuracyScore {
  label: string;
  tp: number;
  fp: number;
  fn: number;
  /** TP / (TP + FP), as the report gives it (three decimals). */
  precision: number | null;
  /** TP / (TP + FN), as the report gives it. */
  recall: number | null;
  /** Where in the report the row was copied from. */
  from: string;
}

export interface AccuracyRow extends AccuracyScore {
  id: string;
  /** A public benchmark someone else wrote, or a corpus of our own. */
  kind: 'public' | 'own';
  /** Labelled cases in the suite. */
  labels: number;
}

export interface ReleaseAccuracy {
  /** The release these numbers were published with (this package's version). */
  release: string;
  /** The report file the numbers are copied from. */
  source: string;
  /** Where the method is written down. */
  method: string;
  measured: { date: string; commit: string; engine: string; adapters: string };
  scope: string;
  rows: AccuracyRow[];
  total: AccuracyScore;
  notShown: { id: string; reason: string }[];
  /** The previous release's numbers, once there is one. */
  previous: Omit<ReleaseAccuracy, 'previous'> | null;
}

export const RELEASE_ACCURACY = accuracy as ReleaseAccuracy;

/** "82.6%", or "—" for a score with a zero denominator (never 0% or 100%). */
export function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}
