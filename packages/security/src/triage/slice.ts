import { estimateTokens } from '@repopulse/analysis';

// The bounded code slice a triage call sees (W19-04).
//
// Numbered, because the model must CITE by line number and we match that number
// back to our own copy of the file — a quote alone can be paraphrased, a number
// either exists in the slice or it does not. Bounded, because the slice shares
// the model's context window with the checklist, the rule provenance and the
// answer. The finding's own lines are always inside it.

export const DEFAULT_RADIUS = 25;

export interface CodeSlice {
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Rendered with a numbered left margin. */
  text: string;
  /** Raw lines, index 0 = startLine. */
  lines: string[];
  /** True when the finding's own span was longer than the budget allowed. */
  truncated: boolean;
}

function render(lines: string[], start: number): string {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join('\n');
}

/**
 * `radius` lines of context either side of the finding, halved until the slice
 * fits `budgetTokens`. Never smaller than the finding's own lines; if even those
 * exceed the budget the span is cut at its end and `truncated` says so.
 */
export function sliceAround(
  source: string,
  file: string,
  lineStart: number,
  lineEnd: number,
  budgetTokens: number,
  radius: number = DEFAULT_RADIUS,
): CodeSlice {
  const all = source.split('\n');
  if (all.at(-1) === '') all.pop();
  const total = all.length;
  const first = Math.min(Math.max(1, lineStart), Math.max(1, total));
  const last = Math.min(Math.max(first, lineEnd), Math.max(1, total));

  for (let r = radius; ; r = Math.floor(r / 2)) {
    const start = Math.max(1, first - r);
    const end = Math.min(total, last + r);
    const lines = all.slice(start - 1, end);
    const text = render(lines, start);
    if (estimateTokens(text) <= budgetTokens) {
      return { file, startLine: start, endLine: end, text, lines, truncated: false };
    }
    if (r === 0) {
      // The span itself is over budget: keep its first lines, say so.
      let keep = lines.length;
      while (keep > 1 && estimateTokens(render(lines.slice(0, keep), start)) > budgetTokens) {
        keep = Math.floor(keep * 0.8);
      }
      const cut = lines.slice(0, Math.max(1, keep));
      return {
        file,
        startLine: start,
        endLine: start + cut.length - 1,
        text: render(cut, start),
        lines: cut,
        truncated: true,
      };
    }
  }
}
