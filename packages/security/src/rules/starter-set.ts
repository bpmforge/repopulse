import { STARTER_SET_MANIFEST } from './starter-set.data.js';

// The starter set (W21-04, owner decision 2026-10-26 "Starter set live").
//
// A fresh install ran every new rule in shadow, so it showed a handful of live
// findings until an admin had promoted something, and promotion needs 20
// findings, 30 days and the workspace's own triage (lifecycle.ts). The owner
// decided that a rule whose precision was MEASURED on public, independent
// benchmarks at 80% or better starts live; every other rule stays in shadow and
// promotes by the unchanged gate.
//
// The evidence is the committed benchmark report, nothing else:
// starter-set.data.ts is generated from docs/benchmarks/report.json by
// `pnpm --filter @repopulse/security starter-set`, and starter-set.test.ts fails
// when an entry drifts from the report or falls below the bar.
//
// What counts as independent evidence is narrow on purpose. Our own corpora
// (`changes`, `sampleco`, `rule-fixtures`) were written by the people who wrote
// the rules, so a rule scores well there by construction. The public suites
// count in full; the tool-adapter suite counts only on its `real` tree (this
// repository's own Dockerfiles and scripts, judged finding by finding), because
// its `triggering` tree is fixtures we wrote. Fast-lane secrets rules have no
// independent sample of five, and anti-slop, logging and performance rules have
// no independent benchmark at all, so none of them qualifies.
//
// An admin's choice always wins: a registry row for the rule (a "Move to
// shadow" override, a promotion, a retirement) is read before the starter set,
// exactly as it is read before a rule file's own lifecycle line.

/** The bar a rule must clear on independent evidence. */
export const STARTER_SET_BAR = {
  /** TP ÷ (TP + FP) on the evidence suites, at least this. */
  minPrecision: 0.8,
  /** At least this many true positives there, so one lucky hit does not qualify. */
  minTruePositives: 5,
} as const;

/**
 * Where independent evidence comes from. `trees` limits a suite to the named
 * trees; absent, every tree of the suite counts.
 */
export const STARTER_SET_EVIDENCE: readonly { suite: string; trees?: readonly string[] }[] = [
  { suite: 'owasp-benchmark' },
  { suite: 'juliet-java' },
  { suite: 'juice-shop' },
  { suite: 'iac-adapters', trees: ['real'] },
];

/** The stage reason shown in Settings → Rules and the finding panel. */
export const STARTER_SET_REASON = 'live via starter set (benchmark evidence)';

export interface StarterSetSuiteEvidence {
  suite: string;
  /** Present when only some trees of the suite count. */
  trees?: string[];
  tp: number;
  fp: number;
}

export interface StarterSetEntry {
  ruleId: string;
  engine: 'yaml' | 'adapter' | 'fast-lane' | null;
  dimension: string | null;
  tp: number;
  fp: number;
  /** Rounded to three places; the bar is checked on the unrounded ratio. */
  precision: number;
  suites: StarterSetSuiteEvidence[];
}

export interface StarterSetManifest {
  source: 'docs/benchmarks/report.json';
  ticket: string;
  measured: { date: string | null; commit: string | null };
  bar: { minPrecision: number; minTruePositives: number };
  evidence: { suite: string; trees?: string[] }[];
  rules: StarterSetEntry[];
  /** Rules with enough independent true positives that miss on precision, stated so the line is visible. */
  belowBar: StarterSetEntry[];
}

/** The subset of docs/benchmarks/report.json the starter set reads. */
export interface StarterSetReportInput {
  ticket: string;
  measured?: { date: string | null; commit: string | null };
  byRule?: { rule: string; engine: string; dimension?: string }[];
  outcomes: { suite: string; tree?: string; ruleId?: string | null; kind: string }[];
}

function counts(suite: string, tree: string | undefined): boolean {
  return STARTER_SET_EVIDENCE.some(
    (e) =>
      e.suite === suite &&
      (e.trees === undefined || (tree !== undefined && e.trees.includes(tree))),
  );
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** True when the evidence clears the bar. Pure. */
export function meetsStarterBar(score: { tp: number; fp: number }): boolean {
  const raised = score.tp + score.fp;
  return (
    score.tp >= STARTER_SET_BAR.minTruePositives &&
    raised > 0 &&
    score.tp / raised >= STARTER_SET_BAR.minPrecision
  );
}

/** Derives the starter set from a benchmark report. Pure; no I/O. */
export function deriveStarterSet(report: StarterSetReportInput): StarterSetManifest {
  const info = new Map((report.byRule ?? []).map((r) => [r.rule, r]));
  const perRule = new Map<string, Map<string, StarterSetSuiteEvidence>>();
  for (const o of report.outcomes) {
    if (!o.ruleId || (o.kind !== 'tp' && o.kind !== 'fp')) continue;
    if (!counts(o.suite, o.tree)) continue;
    const suites = perRule.get(o.ruleId) ?? new Map<string, StarterSetSuiteEvidence>();
    perRule.set(o.ruleId, suites);
    const limited = STARTER_SET_EVIDENCE.find((e) => e.suite === o.suite)?.trees;
    const entry = suites.get(o.suite) ?? {
      suite: o.suite,
      ...(limited ? { trees: [...limited] } : {}),
      tp: 0,
      fp: 0,
    };
    suites.set(o.suite, entry);
    entry[o.kind] += 1;
  }

  const rules: StarterSetEntry[] = [];
  const belowBar: StarterSetEntry[] = [];
  for (const [ruleId, suites] of perRule) {
    const evidence = [...suites.values()].sort((a, b) => a.suite.localeCompare(b.suite));
    const tp = evidence.reduce((n, s) => n + s.tp, 0);
    const fp = evidence.reduce((n, s) => n + s.fp, 0);
    if (tp < STARTER_SET_BAR.minTruePositives) continue;
    const engine = info.get(ruleId)?.engine;
    const entry: StarterSetEntry = {
      ruleId,
      engine: engine === 'yaml' || engine === 'adapter' || engine === 'fast-lane' ? engine : null,
      dimension: info.get(ruleId)?.dimension ?? null,
      tp,
      fp,
      precision: round3(tp / (tp + fp)),
      suites: evidence,
    };
    (meetsStarterBar(entry) ? rules : belowBar).push(entry);
  }
  const byId = (a: StarterSetEntry, b: StarterSetEntry) => a.ruleId.localeCompare(b.ruleId);
  return {
    source: 'docs/benchmarks/report.json',
    ticket: report.ticket,
    measured: report.measured ?? { date: null, commit: null },
    bar: { ...STARTER_SET_BAR },
    evidence: STARTER_SET_EVIDENCE.map((e) => ({
      suite: e.suite,
      ...(e.trees ? { trees: [...e.trees] } : {}),
    })),
    rules: rules.sort(byId),
    belowBar: belowBar.sort(byId),
  };
}

const STARTER = new Map(STARTER_SET_MANIFEST.rules.map((r) => [r.ruleId, r]));

/** The starter-set entry for a rule, or undefined when the rule is not in it. */
export function starterSetEntry(ruleId: string): StarterSetEntry | undefined {
  return STARTER.get(ruleId);
}

/** Every starter-set rule id, in manifest order. */
export function starterRuleIds(): string[] {
  return [...STARTER.keys()];
}

export function isStarterRule(ruleId: string): boolean {
  return STARTER.has(ruleId);
}

/**
 * Does a TOOL-level registry row (`tool.hadolint`) record an admin's choice?
 *
 * The code-health scan seeds one per shadow tool (W20-08) as a candidate with
 * nobody's name on it, which is the shipped default made visible, not a
 * decision. Anything else is: a status other than candidate can only come from
 * the workbench, and a workbench transition stamps `updated_by`.
 */
export function toolRowIsAdminChoice(row: { status: string; updatedBy: number | null }): boolean {
  return row.status !== 'candidate' || row.updatedBy !== null;
}
