// Piecewise ramp normalization (METRICS.md §3): 100 at `good`-or-better, 0 at
// `bad`-or-worse, linear between. One formula handles both directions —
// higher-is-better (good>bad, e.g. pass rate) and lower-is-better (good<bad,
// e.g. days-since-push) — because (x−bad)/(good−bad) is 1 at good and 0 at bad
// regardless of which is larger.
//
// METRICS.md §4 E3: ramp(0.667, 0.9, 0.4) = (0.667−0.4)/(0.9−0.4)×100 = 53.4.
export function ramp(x: number, good: number, bad: number): number {
  if (good === bad) return x >= good ? 100 : 0;
  const t = (x - bad) / (good - bad);
  return Math.max(0, Math.min(1, t)) * 100;
}
