import type { Outcome, Score } from './match.js';
import { score, scoreBy } from './match.js';
import { CHECKOV_CHECKS } from '../scanners/code-health/adapters/checkov.js';
import { PROMOTION_GATE } from '../rules/lifecycle.js';

// The benchmark report (W18-17): one JSON document and its markdown rendering.
//
// DIFFABLE IS THE REQUIREMENT. Nothing in either output depends on when or
// where the run happened — no timestamps, durations or absolute paths — and
// every list is sorted, so the diff between two releases' reports is exactly
// the set of outcomes that changed.

export interface SuiteSummary {
  id: string;
  title: string;
  source: {
    kind: string;
    repository?: string | undefined;
    commit?: string | undefined;
    path?: string | undefined;
    licence: string;
  };
  status: 'scored' | 'not-prepared';
  trees: number;
  labels: number;
}

export interface RuleInfo {
  rule: string;
  engine: 'fast-lane' | 'yaml' | 'adapter';
  dimension: string;
}

export interface EngineSummary {
  fastLane: { rules: number };
  yaml:
    | {
        status: 'ran';
        tool: string;
        version: string;
        packs: string[];
        rules: number;
        parseErrors: string[];
      }
    | { status: 'unavailable'; reason: string };
  /** The tool adapters (checkov, actionlint, hadolint, shellcheck), run in the scan image. */
  adapters?:
    | { status: 'ran'; tools: Record<string, string>; trees: number }
    | { status: 'unavailable'; reason: string };
}

export interface BenchmarkReport {
  schema: 1;
  ticket: 'W18-17';
  scope: string;
  engines: EngineSummary;
  corpus: SuiteSummary[];
  totals: Score;
  byDimension: { dimension: string; score: Score }[];
  byRule: (RuleInfo & { score: Score })[];
  bySuite: { suite: string; score: Score }[];
  /** Per CWE on the public benchmark suites, in their own units (TPR, FPR). */
  byCwe: CweScore[];
  /** When and with what the numbers were taken; null fields = not recorded. */
  measured: { date: string | null; commit: string | null };
  outcomes: Outcome[];
}

/**
 * OWASP Benchmark's own unit: for one CWE, the share of real vulnerabilities
 * found (TPR) and the share of safe look-alikes wrongly flagged (FPR). `youden`
 * is TPR - FPR, the single number the Benchmark publishes: 0 is a coin flip, 1
 * is perfect, below 0 is worse than guessing.
 */
export interface CweScore {
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

const r3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Per (suite, CWE) TPR and FPR for the given suites. Skipped, duplicate and ignored outcomes do not count. */
export function cweScores(outcomes: readonly Outcome[], suites: ReadonlySet<string>): CweScore[] {
  const groups = new Map<string, CweScore>();
  for (const o of outcomes) {
    if (o.cwe === null || !suites.has(o.suite)) continue;
    if (o.kind !== 'tp' && o.kind !== 'fp' && o.kind !== 'fn' && o.kind !== 'tn') continue;
    const key = `${o.suite}\u0000${String(o.cwe).padStart(6, '0')}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        suite: o.suite,
        cwe: o.cwe,
        tp: 0,
        fp: 0,
        fn: 0,
        tn: 0,
        tpr: null,
        fpr: null,
        youden: null,
      };
      groups.set(key, g);
    }
    g[o.kind] += 1;
  }
  return [...groups.keys()].sort().map((k) => {
    const g = groups.get(k)!;
    g.tpr = g.tp + g.fn === 0 ? null : r3(g.tp / (g.tp + g.fn));
    g.fpr = g.fp + g.tn === 0 ? null : r3(g.fp / (g.fp + g.tn));
    g.youden = g.tpr === null || g.fpr === null ? null : r3(g.tpr - g.fpr);
    return g;
  });
}

export const SCOPE =
  'Deterministic layers only: the in-process fast lane (anti_slop arithmetic and graph checks, ' +
  'secrets rulepack) and the YAML rulepacks. No LLM tier is measured.';

export function buildReport(args: {
  engines: EngineSummary;
  corpus: SuiteSummary[];
  rules: readonly RuleInfo[];
  outcomes: Outcome[];
  measured?: { date: string | null; commit: string | null };
}): BenchmarkReport {
  const { outcomes } = args;
  const ruleInfo = new Map(args.rules.map((r) => [r.rule, r]));
  const byRule = scoreBy(
    outcomes,
    (o) => o.ruleId,
    args.rules.map((r) => r.rule),
  ).map(({ key, score: s }) => ({
    rule: key,
    engine: ruleInfo.get(key)?.engine ?? ('yaml' as const),
    dimension: ruleInfo.get(key)?.dimension ?? 'unknown',
    score: s,
  }));
  return {
    schema: 1,
    ticket: 'W18-17',
    scope: SCOPE,
    engines: args.engines,
    corpus: args.corpus,
    totals: score(outcomes),
    byDimension: scoreBy(outcomes, (o) => o.dimension).map(({ key, score: s }) => ({
      dimension: key,
      score: s,
    })),
    byRule,
    bySuite: scoreBy(
      outcomes,
      (o) => o.suite,
      args.corpus.map((c) => c.id),
    ).map(({ key, score: s }) => ({ suite: key, score: s })),
    byCwe: cweScores(
      outcomes,
      new Set(args.corpus.filter((c) => c.source.kind === 'fetched').map((c) => c.id)),
    ),
    measured: args.measured ?? { date: null, commit: null },
    outcomes,
  };
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

function scoreCells(s: Score): string {
  return `${s.tp} | ${s.fp} | ${s.fn} | ${s.duplicate} | ${pct(s.precision)} | ${pct(s.recall)}`;
}

const SCORE_HEAD = 'TP | FP | FN | Dup | Precision | Recall';
const SCORE_RULE = '--:|--:|--:|--:|--:|--:';

export function renderMarkdown(r: BenchmarkReport): string {
  const out: string[] = [];
  out.push('# Repo Pulse benchmark report', '');
  out.push(`Generated by \`packages/security/src/benchmark/cli.ts\` (${r.ticket}). ${r.scope}`, '');
  out.push('## Engines', '');
  out.push(`- Fast lane (in-process): ${r.engines.fastLane.rules} rules`);
  if (r.engines.yaml.status === 'ran') {
    out.push(
      `- YAML packs: ${r.engines.yaml.tool} ${r.engines.yaml.version}, ${r.engines.yaml.rules} rules from ${r.engines.yaml.packs.join(', ')}`,
    );
    if (r.engines.yaml.parseErrors.length > 0) {
      out.push(
        `- Files the YAML engine could not parse (labels only YAML rules could satisfy are skipped there): ${r.engines.yaml.parseErrors.join(', ')}`,
      );
    }
  } else {
    out.push(
      `- YAML packs: not run (${r.engines.yaml.reason}); their labels are skipped, not missed`,
    );
  }
  if (r.engines.adapters?.status === 'ran') {
    const tools = Object.entries(r.engines.adapters.tools)
      .map(([k, v]) => `${k} ${v}`)
      .sort()
      .join(', ');
    out.push(
      `- Tool adapters (scan image, through the code-health scanner): ${tools}; ${r.engines.adapters.trees} trees`,
    );
  } else if (r.engines.adapters) {
    out.push(
      `- Tool adapters: not run (${r.engines.adapters.reason}); their labels are skipped, not missed`,
    );
  }
  out.push('', '## Corpus', '');
  out.push('Suite | Source | Licence | Trees | Labels | Status', '---|---|---|--:|--:|---');
  for (const c of r.corpus) {
    const src = [c.source.kind, c.source.repository, c.source.commit?.slice(0, 12)]
      .filter(Boolean)
      .join(' ');
    out.push(`${c.id} | ${src} | ${c.source.licence} | ${c.trees} | ${c.labels} | ${c.status}`);
  }
  out.push('', '## Totals', '');
  out.push(`Scope | ${SCORE_HEAD}`, `---|${SCORE_RULE}`);
  out.push(`all | ${scoreCells(r.totals)}`);
  out.push('', '## By dimension', '');
  out.push(`Dimension | ${SCORE_HEAD}`, `---|${SCORE_RULE}`);
  for (const d of r.byDimension) out.push(`${d.dimension} | ${scoreCells(d.score)}`);
  out.push('', '## By suite', '');
  out.push(`Suite | ${SCORE_HEAD}`, `---|${SCORE_RULE}`);
  for (const s of r.bySuite) out.push(`${s.suite} | ${scoreCells(s.score)}`);
  if (r.byCwe.length > 0) {
    out.push('', '## Public benchmarks, by CWE', '');
    out.push(
      `Measured ${r.measured.date ?? '(date not recorded)'}${r.measured.commit ? ` at ${r.measured.commit.slice(0, 12)}` : ''}` +
        (r.engines.yaml.status === 'ran'
          ? ` with ${r.engines.yaml.tool} ${r.engines.yaml.version}.`
          : '.'),
      '',
      'TPR is the share of real vulnerabilities found; FPR is the share of safe look-alikes flagged; ' +
        'Youden is TPR − FPR (0 = a coin flip, 1 = perfect, negative = worse than guessing). ' +
        'A CWE we have no rule for shows a TPR of 0%, and stays in the table.',
      '',
    );
    out.push(
      'Suite | CWE | TP | FN | FP | TN | TPR | FPR | Youden',
      '---|--:|--:|--:|--:|--:|--:|--:|--:',
    );
    for (const c of r.byCwe) {
      out.push(
        `${c.suite} | ${c.cwe} | ${c.tp} | ${c.fn} | ${c.fp} | ${c.tn} | ${pct(c.tpr)} | ${pct(c.fpr)} | ${c.youden === null ? '—' : c.youden.toFixed(3)}`,
      );
    }
  }
  out.push('', '## By rule', '');
  out.push(
    'Every rule that ran has a row; all zeros means the corpus neither labels nor provokes it. ' +
      'FN here counts only labels that name the rule; misses no rule claims appear under their dimension.',
    '',
  );
  out.push(`Rule | Engine | Dimension | ${SCORE_HEAD}`, `---|---|---|${SCORE_RULE}`);
  for (const rule of r.byRule) {
    out.push(`${rule.rule} | ${rule.engine} | ${rule.dimension} | ${scoreCells(rule.score)}`);
  }
  out.push(...renderAdapterEvidence(r));
  const listed = (kind: Outcome['kind'], title: string) => {
    const rows = r.outcomes.filter((o) => o.kind === kind);
    out.push('', `## ${title} (${rows.length})`, '');
    if (rows.length === 0) {
      out.push('None.');
      return;
    }
    for (const o of rows) {
      const where = `${o.suite}/${o.tree}/${o.file}${o.line === null ? '' : `:${o.line}`}`;
      const what = o.ruleId ?? `(${o.dimension}, no rule)`;
      out.push(`- \`${where}\` ${what}${o.labelId ? ` — label ${o.labelId}` : ''}`);
    }
  };
  listed('fn', 'Missed (false negatives)');
  listed('fp', 'False positives');
  listed('duplicate', 'Duplicates');
  listed('skipped', 'Skipped labels');
  out.push('');
  return out.join('\n');
}

// ---- Tool adapters: evidence against the promotion gate (W18-48) -------------

/**
 * The benchmark's half of the promotion gate for one rule (rules/lifecycle.ts
 * PROMOTION_GATE): enough labelled findings, and a false-positive rate under
 * the limit. The other half, 30 days in a workspace and that workspace's
 * own triage, is field evidence a labelled corpus cannot supply, so no row can
 * read "eligible" from here: the most it can say is that the benchmark half is in.
 */
export function adapterGate(s: Score): { met: boolean; text: string } {
  const findings = s.tp + s.fp;
  const gaps: string[] = [];
  if (findings < PROMOTION_GATE.minFindings) {
    gaps.push(`${findings}/${PROMOTION_GATE.minFindings} findings`);
  }
  if (findings > 0 && s.fp / findings > PROMOTION_GATE.maxFpRate) {
    gaps.push(
      `${((s.fp / findings) * 100).toFixed(0)}% false positives (limit ${PROMOTION_GATE.maxFpRate * 100}%)`,
    );
  }
  return gaps.length === 0
    ? { met: true, text: 'benchmark half met' }
    : { met: false, text: gaps.join('; ') };
}

function renderAdapterEvidence(r: BenchmarkReport): string[] {
  const rows = r.byRule.filter((x) => x.engine === 'adapter');
  if (rows.length === 0) return [];
  const out: string[] = ['', '## Tool adapters: precision and the promotion gate', ''];
  out.push(
    "Each row is one tool rule, scored raw (before the cross-tool dedupe that decides which of two tools' " +
      'reports of one defect is stored), on our own labelled fixtures. Promotion out of shadow is an admin ' +
      `action in the rule registry on at least ${PROMOTION_GATE.minFindings} findings, ` +
      `${PROMOTION_GATE.minDays} days and under ${PROMOTION_GATE.maxFpRate * 100}% false positives from the ` +
      "workspace's own triage. A benchmark can supply the first and last in kind and never the days or the " +
      'triage, so **no rule below is promoted**; the last column is how far the benchmark half of the evidence ' +
      'gets. Sample sizes are small (a rule has the one to three cases written for it), so a precision of 100% ' +
      'here means "no false positive in those cases", not "precise".',
    '',
  );
  out.push(`Rule | ${SCORE_HEAD} | Benchmark half of the gate`, `---|${SCORE_RULE}|---`);
  for (const x of rows) {
    out.push(`${x.rule} | ${scoreCells(x.score)} | ${adapterGate(x.score).text}`);
  }
  const measured = new Set(
    rows.filter((x) => x.score.tp + x.score.fp + x.score.fn > 0).map((x) => x.rule),
  );
  const checkov = Object.keys(CHECKOV_CHECKS).map((id) => `tool.checkov.${id}`);
  const unrun = checkov.filter((id) => !measured.has(id)).sort();
  out.push('', '### Not yet run', '');
  out.push(
    `checkov runs ${checkov.length} allowlisted checks; ${checkov.length - unrun.length} have a labelled ` +
      'case here. The rest have none, so their precision and recall are **not yet run**, not zero:',
    '',
  );
  out.push(unrun.length > 0 ? unrun.map((id) => `\`${id}\``).join(', ') : 'None.');
  out.push(
    '',
    'hadolint, shellcheck and actionlint have no fixed allowlist (their universe is every code the tool can ' +
      'raise at error or warning level), so every rule not in the table above is **not yet run**.',
  );
  return out;
}
