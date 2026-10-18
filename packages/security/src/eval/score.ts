import type { RoleScore } from './types.js';

export interface CaseTally {
  errored: boolean;
  formatFailure: boolean;
  tp: number;
  fp: number;
  fn: number;
  duplicates: number;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/** Aggregates a role's cases. An errored case is counted but never scored. */
export function scoreRole(cases: readonly CaseTally[]): RoleScore {
  const scored = cases.filter((c) => !c.errored);
  const sum = (k: 'tp' | 'fp' | 'fn' | 'duplicates') => scored.reduce((a, c) => a + c[k], 0);
  const errored = cases.length - scored.length;
  const tp = sum('tp');
  const fp = sum('fp');
  const fn = sum('fn');
  const incomplete = errored > 0;
  return {
    cases: cases.length,
    errored,
    formatFailures: scored.filter((c) => c.formatFailure).length,
    tp,
    fp,
    fn,
    duplicates: sum('duplicates'),
    // Withheld, not zero: a role with a provider error has not been measured.
    precision: incomplete ? null : ratio(tp, tp + fp),
    recall: incomplete ? null : ratio(tp, tp + fn),
    state: incomplete ? 'incomplete' : 'scored',
  };
}
