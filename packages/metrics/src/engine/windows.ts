// METRICS.md header: every metric is parameterized by window W, default 30d.
export const WINDOW_DAYS = [7, 14, 30, 90, 365] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
export const DEFAULT_WINDOW_DAYS: WindowDays = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function windowStart(asOf: Date, days: WindowDays): Date {
  return new Date(asOf.getTime() - days * MS_PER_DAY);
}

export function daysBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / MS_PER_DAY;
}
