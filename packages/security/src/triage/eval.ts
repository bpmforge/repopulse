import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TriageCandidate, TriageFinding, TriageProposal, TriageVerdict } from './types.js';

// Verdict agreement against labelled findings, per model (W19-04).
//
// Each case is a mechanical finding with a known truth (real, or a false
// positive). A model's verdict AGREES when it matches, DISAGREES when it
// contradicts, and ABSTAINS when it says needs_human — an abstention is a good
// answer to an undecidable slice and is reported separately, never counted as
// wrong. A case the pipeline could not turn into a valid verdict (uncited,
// malformed) is REJECTED and shown as such, because a model that cannot follow
// the answer format is a finding about the model.
//
// THE COSTLY ERROR IS NAMED: calling a real finding a false positive hides a
// live problem behind a sentence, so it is counted on its own ("missed real").
// Agreement alone would let a model that waves everything through look decent.

export const TRIAGE_CASES_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/triage/cases.json',
);

export type Truth = 'real' | 'false_positive';

export interface TriageCase {
  id: string;
  truth: Truth;
  why: string;
  finding: TriageFinding;
  reachability: { tier: string | null; detail?: string | null };
  source: string[];
}

export function loadTriageCases(file: string = TRIAGE_CASES_FILE): {
  note: string;
  cases: TriageCase[];
} {
  return JSON.parse(readFileSync(file, 'utf8')) as { note: string; cases: TriageCase[] };
}

export function candidateOf(c: TriageCase, effectiveRisk = 5): TriageCandidate {
  return {
    finding: c.finding,
    reachability: c.reachability,
    source: `${c.source.join('\n')}\n`,
    effectiveRisk,
  };
}

export type CaseOutcome = 'agree' | 'disagree' | 'abstained' | 'rejected';

export interface CaseResult {
  id: string;
  truth: Truth;
  /** null when no valid verdict was obtained. */
  verdict: TriageVerdict | null;
  outcome: CaseOutcome;
}

export function outcomeOf(truth: Truth, verdict: TriageVerdict | null): CaseOutcome {
  if (verdict === null) return 'rejected';
  if (verdict === 'needs_human') return 'abstained';
  return (truth === 'real') === (verdict === 'real') ? 'agree' : 'disagree';
}

export interface TriageEvalRow {
  model: string;
  ranAt: string;
  checklistVersion: string;
  total: number;
  agree: number;
  disagree: number;
  abstained: number;
  rejected: number;
  /** agree / (agree + disagree); null when the model never committed to a verdict. */
  agreement: number | null;
  /** Real findings the model called false positives — the error that hides a live problem. */
  missedReal: number;
  cases: CaseResult[];
}

export interface TriageEvalFile {
  schema: 1;
  rows: TriageEvalRow[];
}

export function scoreModel(args: {
  model: string;
  ranAt: string;
  checklistVersion: string;
  cases: readonly TriageCase[];
  proposals: readonly TriageProposal[];
}): TriageEvalRow {
  const byKey = new Map(args.proposals.map((p) => [p.dedupKey, p]));
  const results: CaseResult[] = args.cases.map((c) => {
    const verdict = byKey.get(c.finding.dedupKey)?.verdict ?? null;
    return { id: c.id, truth: c.truth, verdict, outcome: outcomeOf(c.truth, verdict) };
  });
  const count = (o: CaseOutcome) => results.filter((r) => r.outcome === o).length;
  const agree = count('agree');
  const disagree = count('disagree');
  return {
    model: args.model,
    ranAt: args.ranAt,
    checklistVersion: args.checklistVersion,
    total: results.length,
    agree,
    disagree,
    abstained: count('abstained'),
    rejected: count('rejected'),
    agreement: agree + disagree === 0 ? null : agree / (agree + disagree),
    missedReal: results.filter((r) => r.truth === 'real' && r.verdict === 'likely_false_positive')
      .length,
    cases: results,
  };
}

/** Replaces the model's row (one row per model: a rerun supersedes), keeping the rest. */
export function upsertRow(file: TriageEvalFile, row: TriageEvalRow): TriageEvalFile {
  const rows = [...file.rows.filter((r) => r.model !== row.model), row].sort((a, b) =>
    a.model.localeCompare(b.model),
  );
  return { schema: 1, rows };
}

const pct = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);

/** docs/TRIAGE_EVAL.md, rendered from docs/triage-eval.json. A test asserts the two agree. */
export function renderTriageEval(file: TriageEvalFile, caseNote: string): string {
  const out: string[] = [
    '# Triage verdict agreement',
    '',
    '<!-- Generated from docs/triage-eval.json by packages/security/src/triage/cli.ts. Do not edit. -->',
    '',
    'How often the AI triage role agrees with a labelled answer, per model (W19-04). Each case is a',
    'mechanical finding with a known truth: a real problem or a false positive. The model is shown the',
    'rule, the reachability (not computed for rule-raised findings) and a bounded code slice, and must',
    'cite a line it was shown.',
    '',
    '- **Agreement** — verdicts that match, out of the verdicts the model committed to.',
    '- **Abstained** — `needs_human`. A good answer to a slice that does not settle it; not counted as wrong.',
    '- **Rejected** — no valid verdict (uncited, outside the slice, malformed). A finding about the model.',
    '- **Missed real** — a real finding called a false positive. The costly error: it hides a live problem,',
    '  so it is shown on its own rather than folded into agreement.',
    '',
    `> ${caseNote}`,
    '',
  ];
  if (file.rows.length === 0) {
    out.push(
      '**This has not been run yet.** No model has been scored; run `packages/security/src/triage/cli.ts`.',
      '',
    );
    return out.join('\n');
  }
  out.push(
    '| Model | Cases | Agreement | Agree | Disagree | Abstained | Rejected | Missed real | Checklist | Run |',
    '|---|--:|--:|--:|--:|--:|--:|--:|---|---|',
  );
  for (const r of file.rows) {
    out.push(
      `| \`${r.model}\` | ${r.total} | ${pct(r.agreement)} | ${r.agree} | ${r.disagree} | ${r.abstained} | ${r.rejected} | ${r.missedReal} | ${r.checklistVersion} | ${r.ranAt.slice(0, 10)} |`,
    );
  }
  out.push('', '## Per case', '');
  const ids = file.rows[0]!.cases.map((c) => ({ id: c.id, truth: c.truth }));
  out.push(
    `| Case | Truth | ${file.rows.map((r) => `\`${r.model}\``).join(' | ')} |`,
    `|---|---|${file.rows.map(() => '---|').join('')}`,
  );
  for (const { id, truth } of ids) {
    const cells = file.rows.map((r) => {
      const c = r.cases.find((x) => x.id === id);
      return c ? `${c.verdict ?? 'rejected'} (${c.outcome})` : '—';
    });
    out.push(`| ${id} | ${truth} | ${cells.join(' | ')} |`);
  }
  out.push('');
  return out.join('\n');
}
