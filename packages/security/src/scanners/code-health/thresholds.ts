// Canon thresholds (W9-02, CODE_HEALTH_SUITE.md §2, FR-CH-2).
//
// Every number here is a JUDGEMENT with a cost on both sides: too low and the
// findings list is noise people stop reading, too high and the tool agrees with
// whatever the codebase already looks like. They are workspace-tunable for
// exactly that reason — these are the defaults, not the truth.
//
// WHAT LIZARD ACTUALLY MEASURES, and what it does not: it reports cyclomatic
// complexity (CCN), function length in lines, parameter count and token count.
// It does NOT compute COGNITIVE complexity or nesting depth, which §2 also
// names. Those two are absent here rather than approximated from CCN — a
// "cognitive complexity" number derived from cyclomatic complexity would be
// cyclomatic complexity wearing a different label, and someone would tune a
// threshold against it.

export interface CodeHealthThresholds {
  /** CC above this is a warning-level finding. */
  complexityWarn: number;
  /** CC above this is the critical one. */
  complexityCritical: number;
  /** Function length in lines. */
  functionLines: number;
  /** File length in lines. */
  fileLines: number;
  /** Parameter count. */
  parameters: number;
  /** Duplication percentage that fails the gate. */
  duplicationPct: number;
  /** jscpd clone detection floor. */
  minLines: number;
  minTokens: number;
}

export const CANON_THRESHOLDS: CodeHealthThresholds = {
  complexityWarn: 10,
  complexityCritical: 20,
  functionLines: 50,
  fileLines: 300,
  parameters: 4,
  duplicationPct: 5,
  minLines: 5,
  minTokens: 50,
};

export function resolveThresholds(overrides?: Partial<CodeHealthThresholds>): CodeHealthThresholds {
  // Explicit overrides only; an undefined field means "use the canon value",
  // not "zero". A 0 threshold would flag every function in the repository.
  return { ...CANON_THRESHOLDS, ...(overrides ?? {}) };
}

export type ComplexityRule =
  | 'complexity.cyclomatic'
  | 'complexity.function_length'
  | 'complexity.file_length'
  | 'complexity.parameters';

export interface ThresholdVerdict {
  rule: ComplexityRule;
  severity: number;
  measured: number;
  threshold: number;
  message: string;
}

/**
 * Verdicts for one function.
 *
 * ABOVE, not at: a function of exactly 50 lines against a 50-line threshold is
 * within it. Off-by-one here is the difference between a rule people trust and
 * one they argue with, and the boundary fixtures pin both sides.
 */
export function verdictsForFunction(
  fn: { ccn: number; length: number; parameters: number },
  thresholds: CodeHealthThresholds,
): ThresholdVerdict[] {
  const out: ThresholdVerdict[] = [];

  if (fn.ccn > thresholds.complexityCritical) {
    out.push({
      rule: 'complexity.cyclomatic',
      // 3, the top of the code-health scale. Complexity is not exploitability
      // (W9-01), so nothing here competes with a security finding.
      severity: 3,
      measured: fn.ccn,
      threshold: thresholds.complexityCritical,
      message: `Cyclomatic complexity ${fn.ccn} is past the critical threshold of ${thresholds.complexityCritical}. Every branch is a path a test has to cover, and nobody covers this many.`,
    });
  } else if (fn.ccn > thresholds.complexityWarn) {
    out.push({
      rule: 'complexity.cyclomatic',
      severity: 2,
      measured: fn.ccn,
      threshold: thresholds.complexityWarn,
      message: `Cyclomatic complexity ${fn.ccn} is above ${thresholds.complexityWarn}. Worth splitting before it needs a diagram.`,
    });
  }

  if (fn.length > thresholds.functionLines) {
    out.push({
      rule: 'complexity.function_length',
      severity: 2,
      measured: fn.length,
      threshold: thresholds.functionLines,
      message: `Function is ${fn.length} lines, over ${thresholds.functionLines}. Long functions hide their own structure — the parts that could be named are the ones a reader has to hold in their head.`,
    });
  }

  if (fn.parameters > thresholds.parameters) {
    out.push({
      rule: 'complexity.parameters',
      severity: 1,
      measured: fn.parameters,
      threshold: thresholds.parameters,
      message: `${fn.parameters} parameters, over ${thresholds.parameters}. Usually a struct waiting to be named, and always a call site that is easy to get wrong.`,
    });
  }

  return out;
}
