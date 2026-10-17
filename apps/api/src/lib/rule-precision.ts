import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { read, security, type Database } from '@repopulse/shared';
import { fpRate } from '@repopulse/security';
import { BENCHMARK_PRECISION } from './benchmark-precision.data.js';

// Per-rule precision, from the two places it is actually measured (W18-22).
//
// TWO SOURCES, NEVER BLENDED. Triage says how often THIS workspace's reviewers
// called a rule's findings wrong; the benchmark says how often the rule was
// wrong on a labelled corpus nobody here wrote. They answer different
// questions over different code, and averaging them would produce a number
// that describes neither — so each travels with its own sample size and its
// own name, and a rule with neither says "not measured yet" instead of
// inheriting a default.
//
// The benchmark is read from a copy BUNDLED at build time
// (benchmark-precision.data.ts, checked against docs/benchmarks/report.json by
// a drift test). Never run at request time: it needs a semgrep binary and a
// corpus, and a page load is not a place to start either.

/** The subset of docs/benchmarks/report.json this module reads. */
export interface BenchmarkReportInput {
  ticket: string;
  engines: { yaml?: { status?: string; tool?: string; version?: string } };
  outcomes: { suite: string; ruleId?: string | null; kind: string }[];
  byRule?: { rule: string; engine: string }[];
  /** Per-CWE accuracy on the public suites (absent in reports older than W18-40). */
  byCwe?: PublicCweScore[];
  corpus?: { id: string; title: string; status: string }[];
  measured?: { date: string | null; commit: string | null };
}

/**
 * One CWE on a public benchmark suite, in the Benchmark's own units: TPR is the
 * share of real vulnerabilities found, FPR the share of safe look-alikes
 * flagged, Youden their difference (0 = coin flip, negative = worse).
 */
export interface PublicCweScore {
  suite: string;
  cwe: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  tpr: number | null;
  fpr: number | null;
  youden: number | null;
}

export interface BenchmarkRuleScore {
  tp: number;
  fp: number;
  fn: number;
  /** null when the rule raised nothing on the corpus: 0/0 is not a precision. */
  precision: number | null;
  suites: string[];
  /**
   * Which engine produced the rule's findings: 'yaml' rules ran under the
   * report's semgrep version, 'fast-lane' rules in-process, 'adapter' rules
   * (checkov, actionlint, hadolint, shellcheck) in the scan image. null if unrecorded.
   */
  engine: 'yaml' | 'fast-lane' | 'adapter' | null;
}

export interface BenchmarkSummary {
  ticket: string;
  /** The YAML engine the numbers were taken with, e.g. "semgrep 1.181.0". */
  engine: string | null;
  /** Suites left out, with why — the reader is owed the denominator. */
  excludedSuites: { suite: string; reason: string }[];
  rules: Record<string, BenchmarkRuleScore>;
  /** Public-suite accuracy per CWE, including where we score badly; empty until a public suite is prepared and run. */
  cwes: PublicCweScore[];
  /** Titles of the public suites that were scored, so the table says what it measured. */
  publicSuites: { id: string; title: string }[];
  /** When the numbers were taken; both null if the run did not record it. */
  measured: { date: string | null; commit: string | null };
}

/**
 * The rule-fixtures suite is excluded from per-rule precision.
 *
 * Every rule was WRITTEN against its own trigger and clean fixtures, so it
 * scores 100% there by construction (the report says as much). Counting those
 * would let the rules with the least outside evidence show the best numbers.
 */
export const EXCLUDED_SUITES: { suite: string; reason: string }[] = [
  {
    suite: 'rule-fixtures',
    reason: 'Each rule was written against its own fixtures, so scoring it there measures nothing.',
  },
];

/** Derive per-rule precision from a benchmark report. Pure; no I/O. */
export function summariseBenchmark(report: BenchmarkReportInput): BenchmarkSummary {
  const excluded = new Set(EXCLUDED_SUITES.map((s) => s.suite));
  const rules: Record<string, BenchmarkRuleScore> = {};
  const engineOf = new Map((report.byRule ?? []).map((r) => [r.rule, r.engine]));
  for (const outcome of report.outcomes) {
    if (excluded.has(outcome.suite) || !outcome.ruleId) continue;
    if (outcome.kind !== 'tp' && outcome.kind !== 'fp' && outcome.kind !== 'fn') continue;
    const engine = engineOf.get(outcome.ruleId);
    const score = (rules[outcome.ruleId] ??= {
      tp: 0,
      fp: 0,
      fn: 0,
      precision: null,
      suites: [],
      engine: engine === 'yaml' || engine === 'fast-lane' || engine === 'adapter' ? engine : null,
    });
    score[outcome.kind] += 1;
    if (!score.suites.includes(outcome.suite)) score.suites.push(outcome.suite);
  }
  for (const score of Object.values(rules)) {
    const raised = score.tp + score.fp;
    score.precision = raised === 0 ? null : Math.round((score.tp / raised) * 1000) / 1000;
    score.suites.sort();
  }
  const yaml = report.engines.yaml;
  return {
    ticket: report.ticket,
    engine:
      yaml?.status === 'ran' && yaml.tool ? `${yaml.tool} ${yaml.version ?? ''}`.trim() : null,
    excludedSuites: EXCLUDED_SUITES,
    rules: Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))),
    cwes: report.byCwe ?? [],
    publicSuites: (report.corpus ?? [])
      .filter((c) => c.status === 'scored' && (report.byCwe ?? []).some((w) => w.suite === c.id))
      .map((c) => ({ id: c.id, title: c.title })),
    measured: report.measured ?? { date: null, commit: null },
  };
}

/**
 * Rules that ship in code and run in shadow until promoted (anti-slop/run.ts,
 * `shippedRuleStatus`). Not exported by @repopulse/security, so named here;
 * any rule whose findings arrive stamped experimental is ALSO treated as
 * shadow (see lifecycleFor), so a new shadow rule is never shown as live just
 * because this list lags.
 */
export const SHIPPED_SHADOW_RULES: readonly string[] = [
  'slop.unused_export',
  'slop.phantom_symbol',
  'slop.phantom_module',
];

/**
 * `pack` = ships in a versioned rulepack and is always on: not in the
 * registry, because the registry governs only rules working through shadow.
 * The other four are the registry's own states (CODE_HEALTH_SUITE.md §8.2).
 */
export type RuleLifecycle = 'pack' | 'proposed' | 'candidate' | 'active' | 'deprecated';

export interface TriagePrecision {
  /** Findings a person has decided on (confirmed, dismissed, resolved, won't fix). */
  triaged: number;
  falsePositives: number;
  /** 1 − FP rate; null when nobody has triaged anything. Never 0 or 1 by default. */
  precision: number | null;
}

export interface RulePrecision {
  ruleId: string;
  lifecycle: RuleLifecycle;
  /** Why the lifecycle reads as it does: a registry row, or the shipped default. */
  lifecycleSource: 'registry' | 'shipped default' | 'observed shadow findings' | 'rulepack';
  findings: number;
  triage: TriagePrecision;
  /** null = this rule is not in the benchmark corpus at all. */
  benchmark: BenchmarkRuleScore | null;
}

export interface RulePrecisionReport {
  benchmark: Pick<
    BenchmarkSummary,
    'ticket' | 'engine' | 'excludedSuites' | 'cwes' | 'publicSuites' | 'measured'
  >;
  rules: RulePrecision[];
}

function lifecycleFor(
  ruleId: string,
  registry: Map<string, string>,
  sawExperimental: boolean,
): Pick<RulePrecision, 'lifecycle' | 'lifecycleSource'> {
  const status = registry.get(ruleId);
  if (
    status === 'proposed' ||
    status === 'candidate' ||
    status === 'active' ||
    status === 'deprecated'
  ) {
    return { lifecycle: status, lifecycleSource: 'registry' };
  }
  if (SHIPPED_SHADOW_RULES.includes(ruleId)) {
    return { lifecycle: 'candidate', lifecycleSource: 'shipped default' };
  }
  if (sawExperimental)
    return { lifecycle: 'candidate', lifecycleSource: 'observed shadow findings' };
  return { lifecycle: 'pack', lifecycleSource: 'rulepack' };
}

/**
 * Every rule this workspace can say something about, with both measurements.
 *
 * The rule set is the union of: rules that raised a finding here, rules in the
 * registry, the shipped shadow rules, and rules the benchmark scored. A rule
 * that is in none of those has nothing to show and is left out rather than
 * listed with blanks. Workspace-scoped in every query (Law 5).
 */
export async function rulePrecision(
  db: Database,
  workspaceId: number,
  opts: { ruleId?: string; summary?: BenchmarkSummary } = {},
): Promise<RulePrecisionReport> {
  const summary = opts.summary ?? BENCHMARK_PRECISION;
  const ruleFilter = opts.ruleId === undefined ? [] : [eq(read.findings.ruleId, opts.ruleId)];

  const counts = await db
    .select({
      ruleId: read.findings.ruleId,
      findings: sql<number>`count(*)::int`,
      triaged: sql<number>`count(*) filter (where ${read.findings.status} in ('confirmed','dismissed','resolved','wont_fix'))::int`,
      fp: sql<number>`count(*) filter (where ${read.findings.status} = 'dismissed' and ${read.findings.dismissReason} = 'false_positive')::int`,
      experimental: sql<boolean>`bool_or(${read.findings.experimental})`,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        isNotNull(read.findings.ruleId),
        ...ruleFilter,
      ),
    )
    .groupBy(read.findings.ruleId);

  const registryRows = await db
    .select({ ruleId: security.ruleRegistry.ruleId, status: security.ruleRegistry.status })
    .from(security.ruleRegistry)
    .where(
      and(
        eq(security.ruleRegistry.workspaceId, workspaceId),
        ...(opts.ruleId === undefined ? [] : [eq(security.ruleRegistry.ruleId, opts.ruleId)]),
      ),
    );
  const registry = new Map(registryRows.map((r) => [r.ruleId, r.status]));
  const byRule = new Map(counts.filter((c) => c.ruleId !== null).map((c) => [c.ruleId!, c]));

  const ids =
    opts.ruleId !== undefined
      ? [opts.ruleId]
      : [
          ...new Set([
            ...byRule.keys(),
            ...registry.keys(),
            ...SHIPPED_SHADOW_RULES,
            ...Object.keys(summary.rules),
          ]),
        ].sort();

  const rules = ids.map((ruleId): RulePrecision => {
    const c = byRule.get(ruleId);
    const triaged = c?.triaged ?? 0;
    const falsePositives = c?.fp ?? 0;
    const rate = fpRate({ dismissedFalsePositive: falsePositives, triaged });
    return {
      ruleId,
      ...lifecycleFor(ruleId, registry, c?.experimental === true),
      findings: c?.findings ?? 0,
      triage: {
        triaged,
        falsePositives,
        precision: rate === null ? null : Math.round((1 - rate) * 1000) / 1000,
      },
      benchmark: summary.rules[ruleId] ?? null,
    };
  });

  return {
    benchmark: {
      ticket: summary.ticket,
      engine: summary.engine,
      excludedSuites: summary.excludedSuites,
      cwes: summary.cwes,
      publicSuites: summary.publicSuites,
      measured: summary.measured,
    },
    rules,
  };
}
