// Trust-surface wire contracts (W18-22). Sources: apps/api/src/lib/rule-precision.ts
// and apps/api/src/lib/coverage-map.ts, served by apps/api/src/routes/trust.

export type RuleLifecycle = 'pack' | 'proposed' | 'candidate' | 'active' | 'deprecated';

export interface BenchmarkRuleScore {
  tp: number;
  fp: number;
  fn: number;
  /** null when the rule raised nothing on the corpus: 0/0 is not a precision. */
  precision: number | null;
  suites: string[];
  /**
   * 'yaml' ran under the report's semgrep version; 'fast-lane' in-process;
   * 'adapter' is a third-party tool run in the scan image.
   */
  engine: 'yaml' | 'fast-lane' | 'adapter' | null;
}

/** One starter-set rule's benchmark evidence (packages/security/src/rules/starter-set.ts). */
export interface StarterSetEvidence {
  ruleId: string;
  tp: number;
  fp: number;
  precision: number;
  suites: { suite: string; trees?: string[]; tp: number; fp: number }[];
}

export interface RulePrecision {
  ruleId: string;
  lifecycle: RuleLifecycle;
  lifecycleSource:
    | 'registry'
    | 'shipped default'
    | 'observed shadow findings'
    | 'rulepack'
    | 'starter set'
    | 'hand-checked';
  /**
   * W21-04: live because the rule is in the starter set (precision measured on
   * independent benchmarks). W21-20: also set, same shape, for a hand-checked
   * performance rule (suites are the repositories marked). Absent from an API
   * older than W21-04.
   */
  starter?: { reason: string; evidence: StarterSetEvidence } | null;
  findings: number;
  triage: { triaged: number; falsePositives: number; precision: number | null };
  benchmark: BenchmarkRuleScore | null;
  /** W20-21 (FND-53): a shipped rule moved to shadow in this workspace; Restore undoes it. */
  override?: boolean;
}

export interface PublicCweScore {
  suite: string;
  cwe: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Share of real vulnerabilities found; null when the suite has none for this CWE. */
  tpr: number | null;
  /** Share of safe look-alikes flagged; null when the suite has none for this CWE. */
  fpr: number | null;
  /** TPR − FPR: 0 is a coin flip, 1 is perfect, negative is worse than guessing. */
  youden: number | null;
}

export interface RulePrecisionReport {
  benchmark: {
    ticket: string;
    engine: string | null;
    excludedSuites: { suite: string; reason: string }[];
    /** Absent from an API older than W18-40. */
    cwes?: PublicCweScore[];
    publicSuites?: { id: string; title: string }[];
    measured?: { date: string | null; commit: string | null };
  };
  rules: RulePrecision[];
}

export interface CoverageSection<T> {
  checked: string;
  evidence: 'known' | 'unknown';
  items: T[];
}

export interface LanguageGap {
  language: string;
  files: number;
}

export interface CoverageMapPayload {
  repoId: number;
  languages: CoverageSection<LanguageGap> & {
    present: (LanguageGap & { packs: string[]; fastLane: boolean })[];
  };
  skippedFiles: CoverageSection<{
    scannerKey: string;
    runId: number;
    at: string | null;
    partial: boolean;
    count: number | null;
  }>;
  scanners: CoverageSection<{
    key: string;
    label: string;
    reason: 'not_in_build' | 'not_supported' | 'disabled' | 'never_run' | 'last_run_failed';
    detail: string;
  }>;
  shadowRules: CoverageSection<{
    ruleId: string;
    source: 'registry' | 'shipped default' | 'observed shadow findings';
    openShadowFindings: number;
  }>;
}

/** Below this many decisions a percentage says more than the evidence does. */
export const SMALL_SAMPLE = 10;

/** Word + glyph, never colour alone (UX_SPEC §7). */
export const LIFECYCLE_LABEL: Record<RuleLifecycle, string> = {
  pack: '● shipped in a rulepack — counts everywhere',
  proposed: '· proposed — not running',
  candidate: '◐ shadow — running, excluded from every score',
  active: '✓ active — counts everywhere',
  deprecated: '✕ deprecated — not running',
};

export const SCANNER_GAP_LABEL: Record<
  CoverageMapPayload['scanners']['items'][number]['reason'],
  string
> = {
  not_in_build: 'not in this build',
  not_supported: 'not supported in this release',
  disabled: 'turned off here',
  never_run: 'never run here',
  last_run_failed: 'last run did not finish',
};

/** Display order for scanner gaps: the ones someone can act on first. */
export const SCANNER_GAP_ORDER: CoverageMapPayload['scanners']['items'][number]['reason'][] = [
  'last_run_failed',
  'disabled',
  'never_run',
  'not_in_build',
  'not_supported',
];

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface PrecisionText {
  /** The headline: a percentage, or "not measured yet". */
  value: string;
  /** Sample size and source, always shown beside the value. */
  basis: string;
  measured: boolean;
  small: boolean;
}

/**
 * Triage precision, in words.
 *
 * "not measured yet" over a null — never 0% or 100%: a rule nobody has triaged
 * has not been shown to be right OR wrong.
 */
export function triageText(t: RulePrecision['triage']): PrecisionText {
  if (t.precision === null || t.triaged === 0) {
    return {
      value: 'not measured yet',
      basis: 'no finding from this rule has been triaged in this workspace',
      measured: false,
      small: false,
    };
  }
  return {
    value: pct(t.precision),
    basis: `${t.triaged - t.falsePositives} of ${t.triaged} triaged findings not marked false positive · your triage`,
    measured: true,
    small: t.triaged < SMALL_SAMPLE,
  };
}

/** Benchmark precision, in words, with the corpus it came from. */
export function benchmarkText(
  b: BenchmarkRuleScore | null,
  source: RulePrecisionReport['benchmark'],
): PrecisionText {
  // The engine version applies to YAML rules only: a fast-lane rule ran
  // in-process, and labelling it with semgrep's version would misstate how it
  // was measured.
  const engine =
    b?.engine === 'fast-lane'
      ? ', in-process'
      : b?.engine === 'adapter'
        ? ', tool run in the scan image'
        : b?.engine === 'yaml' && source.engine
          ? `, ${source.engine}`
          : '';
  const where = `${source.ticket} benchmark${engine}`;
  if (b === null) {
    return {
      value: 'not measured yet',
      basis: `not in the ${source.ticket} benchmark corpus`,
      measured: false,
      small: false,
    };
  }
  const raised = b.tp + b.fp;
  if (b.precision === null || raised === 0) {
    return {
      value: 'not measured yet',
      basis: `raised nothing on the corpus (missed ${b.fn} labelled case${b.fn === 1 ? '' : 's'}) · ${where}`,
      measured: false,
      small: false,
    };
  }
  return {
    value: pct(b.precision),
    basis: `${b.tp} of ${raised} raised were real · ${where}`,
    measured: true,
    small: raised < SMALL_SAMPLE,
  };
}

/**
 * A rule's evidence column. A rule live by hand-check (W21-20) is measured by
 * the marks on real repositories, not by the benchmark corpus it is absent
 * from, so it shows those marks; "not measured yet" next to "live via
 * hand-checked evidence" read as a contradiction (2026-10-27 walkthrough).
 */
export function evidenceText(
  rule: Pick<RulePrecision, 'lifecycleSource' | 'starter' | 'benchmark'>,
  source: RulePrecisionReport['benchmark'],
): PrecisionText {
  const e = rule.lifecycleSource === 'hand-checked' ? rule.starter?.evidence : undefined;
  if (e) {
    const marked = e.tp + e.fp;
    const repos = e.suites.length;
    return {
      value: pct(e.precision),
      basis: `${e.tp} of ${marked} marked real by hand on ${repos} public ${repos === 1 ? 'repository' : 'repositories'} · W21-20 hand-check`,
      measured: true,
      small: marked < SMALL_SAMPLE,
    };
  }
  return benchmarkText(rule.benchmark, source);
}

/** Defensive read: a payload missing its sections is treated as unavailable. */
export function isCoverageMap(value: unknown): value is CoverageMapPayload {
  const v = value as Partial<CoverageMapPayload> | null | undefined;
  return Boolean(v?.languages && v.skippedFiles && v.scanners && v.shadowRules);
}

export function isPrecisionReport(value: unknown): value is RulePrecisionReport {
  const v = value as Partial<RulePrecisionReport> | null | undefined;
  return Boolean(v?.benchmark && Array.isArray(v.rules));
}
