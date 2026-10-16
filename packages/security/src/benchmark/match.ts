// Benchmark matcher and scorer (W18-17).
//
// Pure functions only: findings and labels in, outcomes and counts out. The
// runner (run.ts) owns everything that touches the disk or a subprocess, so
// what decides a number can be tested without a corpus or an engine.
//
// ONE FINDING, ONE LABEL. A label is satisfied by at most one finding and a
// finding satisfies at most one label. Without that, a rule that reports the
// same line twice would score two true positives for one defect, and a rule
// that fires on everything near a label would look perfect.

export type Engine = 'fast-lane' | 'yaml';

export interface BenchFinding {
  suite: string;
  tree: string;
  /** Path relative to the tree root, POSIX separators. */
  file: string;
  lineStart: number;
  lineEnd: number;
  ruleId: string;
  dimension: string;
  /** CWE number from the rule's metadata, when it has one. */
  cwe: number | null;
}

export interface Label {
  suite: string;
  tree: string;
  /** Stable within its suite; what a report row points back to. */
  id: string;
  file: string;
  /** Inclusive line range; absent = the defect is the file (LDR, OWASP cases). */
  lines?: readonly [number, number];
  /** The rule meant to catch it. Absent = no specific rule claims it. */
  rule?: string;
  /** Other rule ids that satisfy the label equally (language variants). */
  accept?: readonly string[];
  /** Matches any finding carrying this CWE (OWASP Benchmark's own unit). */
  cwe?: number;
  dimension: string;
  /** `finding`: a defect we expect reported. `none`: a near-miss that must stay quiet. */
  expect: 'finding' | 'none';
  note?: string;
}

/** What a suite does with a finding no label speaks to. */
export type UnlabelledPolicy = 'fp' | 'ignore';

export type OutcomeKind = 'tp' | 'fp' | 'fn' | 'tn' | 'duplicate' | 'ignored' | 'skipped';

export interface Outcome {
  kind: OutcomeKind;
  suite: string;
  tree: string;
  file: string;
  line: number | null;
  /** The finding's rule for tp/fp/duplicate/ignored; the label's rule (or null) otherwise. */
  ruleId: string | null;
  dimension: string;
  labelId: string | null;
  /** The finding's CWE for tp/fp/duplicate/ignored; the label's for fn/tn/skipped. null if neither has one. */
  cwe: number | null;
}

export interface MatchInput {
  findings: readonly BenchFinding[];
  labels: readonly Label[];
  /** Rule ids whose engine actually ran. A label naming only absent rules is skipped, not missed. */
  rulesRun: ReadonlySet<string>;
  /** Dimensions some rule that ran can report. A rule-less label outside them is skipped. */
  dimensionsRun: ReadonlySet<string>;
  policy: (suite: string) => UnlabelledPolicy;
  /**
   * Files (`suite/tree/file`) a parsing engine could not read, and the rules
   * that depend on that parse. A label only those rules could satisfy is
   * skipped on such a file: the rule never saw the code, so a miss there says
   * nothing about the rule.
   */
  unparsed?: { files: ReadonlySet<string>; rules: ReadonlySet<string> };
}

function overlaps(f: BenchFinding, lines: readonly [number, number] | undefined): boolean {
  if (!lines) return true;
  return f.lineStart <= lines[1] && f.lineEnd >= lines[0];
}

/** Whether a finding speaks to a label: same place, and the right kind of finding. */
export function satisfies(f: BenchFinding, l: Label): boolean {
  if (f.suite !== l.suite || f.tree !== l.tree || f.file !== l.file) return false;
  if (!overlaps(f, l.lines)) return false;
  if (l.rule !== undefined) return f.ruleId === l.rule || (l.accept ?? []).includes(f.ruleId);
  if (l.cwe !== undefined) return f.cwe === l.cwe;
  return f.dimension === l.dimension;
}

function labelRuns(l: Label, input: MatchInput): boolean {
  if (l.rule !== undefined) {
    const rules = [l.rule, ...(l.accept ?? [])];
    const blind =
      input.unparsed?.files.has(`${l.suite}/${l.tree}/${l.file}`) === true &&
      rules.every((r) => input.unparsed?.rules.has(r));
    return !blind && rules.some((r) => input.rulesRun.has(r));
  }
  return input.dimensionsRun.has(l.dimension);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareFindings(a: BenchFinding, b: BenchFinding): number {
  return (
    cmp(a.suite, b.suite) ||
    cmp(a.tree, b.tree) ||
    cmp(a.file, b.file) ||
    a.lineStart - b.lineStart ||
    a.lineEnd - b.lineEnd ||
    cmp(a.ruleId, b.ruleId)
  );
}

export function compareOutcomes(a: Outcome, b: Outcome): number {
  return (
    cmp(a.suite, b.suite) ||
    cmp(a.tree, b.tree) ||
    cmp(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    cmp(a.ruleId ?? '', b.ruleId ?? '') ||
    cmp(a.labelId ?? '', b.labelId ?? '') ||
    cmp(a.kind, b.kind)
  );
}

/**
 * Every finding and every label, classified.
 *
 * Greedy over a fixed order (findings by place then rule, labels by id), which
 * is what makes two runs over the same input produce byte-identical reports.
 * A specific label (one naming a rule) is preferred over a rule-less one, so a
 * finding that both a rule label and a dimension label could take satisfies
 * the one it was written for.
 */
export function matchFindings(input: MatchInput): Outcome[] {
  const findings = [...input.findings].sort(compareFindings);
  const labels = [...input.labels].sort(
    (a, b) => cmp(a.suite, b.suite) || cmp(a.tree, b.tree) || cmp(a.id, b.id),
  );
  const active = labels.filter((l) => labelRuns(l, input));
  const matched = new Set<Label>();
  const outcomes: Outcome[] = [];

  for (const f of findings) {
    const candidates = active.filter((l) => satisfies(f, l));
    const positives = candidates
      .filter((l) => l.expect === 'finding')
      .sort((a, b) => Number(a.rule === undefined) - Number(b.rule === undefined));
    const free = positives.find((l) => !matched.has(l));
    const base = {
      suite: f.suite,
      tree: f.tree,
      file: f.file,
      line: f.lineStart,
      ruleId: f.ruleId,
      dimension: f.dimension,
      cwe: f.cwe,
    };
    if (free) {
      matched.add(free);
      outcomes.push({ ...base, kind: 'tp', labelId: free.id });
      continue;
    }
    if (positives.length > 0) {
      // Another finding already took this defect. Not a false positive — the
      // code IS wrong there — but not a second true one either.
      outcomes.push({ ...base, kind: 'duplicate', labelId: positives[0]!.id });
      continue;
    }
    const negative = candidates.find((l) => l.expect === 'none');
    if (negative) {
      matched.add(negative);
      outcomes.push({ ...base, kind: 'fp', labelId: negative.id });
      continue;
    }
    const kind = input.policy(f.suite) === 'ignore' ? 'ignored' : 'fp';
    outcomes.push({ ...base, kind, labelId: null });
  }

  for (const l of labels) {
    const base = {
      suite: l.suite,
      tree: l.tree,
      file: l.file,
      line: l.lines?.[0] ?? null,
      ruleId: l.rule ?? null,
      dimension: l.dimension,
      labelId: l.id,
      cwe: l.cwe ?? null,
    };
    if (!active.includes(l)) {
      outcomes.push({ ...base, kind: 'skipped' });
    } else if (l.expect === 'finding' && !matched.has(l)) {
      outcomes.push({ ...base, kind: 'fn' });
    } else if (l.expect === 'none' && !matched.has(l)) {
      outcomes.push({ ...base, kind: 'tn' });
    }
  }

  return outcomes.sort(compareOutcomes);
}

export interface Score {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  duplicate: number;
  ignored: number;
  skipped: number;
  /** null when nothing was reported: precision over zero findings is undefined, not 1. */
  precision: number | null;
  /** null when nothing was expected. */
  recall: number | null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

export function score(outcomes: readonly Outcome[]): Score {
  const count = (k: OutcomeKind) => outcomes.filter((o) => o.kind === k).length;
  const tp = count('tp');
  const fp = count('fp');
  const fn = count('fn');
  return {
    tp,
    fp,
    fn,
    tn: count('tn'),
    duplicate: count('duplicate'),
    ignored: count('ignored'),
    skipped: count('skipped'),
    precision: tp + fp === 0 ? null : round(tp / (tp + fp)),
    recall: tp + fn === 0 ? null : round(tp / (tp + fn)),
  };
}

/** Outcomes grouped by a key, keys sorted, each group scored. */
export function scoreBy(
  outcomes: readonly Outcome[],
  key: (o: Outcome) => string | null,
  seed: readonly string[] = [],
): { key: string; score: Score }[] {
  const groups = new Map<string, Outcome[]>(seed.map((k) => [k, []]));
  for (const o of outcomes) {
    const k = key(o);
    if (k === null) continue;
    const list = groups.get(k) ?? [];
    list.push(o);
    groups.set(k, list);
  }
  return [...groups.keys()].sort(cmp).map((k) => ({ key: k, score: score(groups.get(k)!) }));
}
