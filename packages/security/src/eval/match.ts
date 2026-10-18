import type { EvalLabel } from './types.js';

// Matching findings to planted defects (W19-05). One finding satisfies at most
// one label and a label is satisfied at most once (the benchmark's rule): a
// model that reports the same line three times has found one defect, not three.

export interface MatchableFinding {
  file: string;
  evidence_quote: string;
  line_range: [number, number];
}

export interface MatchResult {
  tp: number;
  fp: number;
  fn: number;
  duplicates: number;
}

const norm = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[+\- ]/, '')
    .trim()
    .toLowerCase();

/** The finding's quote covers the label's quote (or the reverse), on the right file. */
function matches(f: MatchableFinding, l: EvalLabel): boolean {
  if (f.file !== l.file) return false;
  const fq = norm(f.evidence_quote);
  const lq = norm(l.quote);
  if (fq === '' || lq === '') return false;
  return fq.includes(lq) || lq.includes(fq);
}

export function matchFindings(
  findings: readonly MatchableFinding[],
  labels: readonly EvalLabel[],
): MatchResult {
  const satisfied = new Set<number>();
  let tp = 0;
  let fp = 0;
  let duplicates = 0;

  for (const f of findings) {
    const open = labels.findIndex((l, i) => !satisfied.has(i) && matches(f, l));
    if (open >= 0) {
      satisfied.add(open);
      tp += 1;
    } else if (labels.some((l) => matches(f, l))) {
      duplicates += 1;
    } else {
      fp += 1;
    }
  }
  return { tp, fp, fn: labels.length - satisfied.size, duplicates };
}
