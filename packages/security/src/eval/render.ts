import { SPECIALIST_IDS, specialistById } from '@repopulse/analysis';
import type { ModelEvalFile, ModelEvalRow, RoleScore } from './types.js';

// docs/MODEL_EVAL.md, rendered from results.generated.ts (W19-05). A test
// asserts the two agree, so the page cannot be hand-edited into a claim the data
// does not make. Anything unmeasured says "not yet run".

const pct = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);

export function roleCell(score: RoleScore | undefined): {
  precision: string;
  recall: string;
  note: string;
} {
  if (!score) return { precision: 'not yet run', recall: 'not yet run', note: '' };
  if (score.state === 'incomplete') {
    return {
      precision: 'incomplete',
      recall: 'incomplete',
      note: `${score.errored} of ${score.cases} cases hit a provider error and were not scored`,
    };
  }
  return { precision: pct(score.precision), recall: pct(score.recall), note: '' };
}

function section(row: ModelEvalRow): string[] {
  const out: string[] = [
    `### \`${row.model}\``,
    '',
    `Engine: ${row.engine} · run ${row.ranAt.slice(0, 10)} · temperature ${row.temperature} · seed ${row.seed === null ? 'not requested' : `${row.seed} (requested; the provider may ignore it)`} · ${row.complete ? 'complete' : '**INCOMPLETE — provider errors below**'}`,
    '',
    '| Role | Checklist | Cases | Precision | Recall | TP | FP | FN | Not scored | Format failures |',
    '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|',
  ];
  for (const role of SPECIALIST_IDS) {
    const s = row.roles[role];
    const c = roleCell(s);
    out.push(
      s
        ? `| ${specialistById(role).label} | ${row.checklistVersions[role] ?? '—'} | ${s.cases} | ${c.precision} | ${c.recall} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.errored} | ${s.formatFailures} |`
        : `| ${specialistById(role).label} | — | — | not yet run | not yet run | — | — | — | — | — |`,
    );
  }
  out.push('');
  out.push(
    row.triage
      ? `Triage agreement: ${pct(row.triage.agreement)} (${row.triage.agree} agree, ${row.triage.disagree} disagree, ${row.triage.abstained} abstained, ${row.triage.rejected} rejected, ${row.triage.missedReal} missed real, of ${row.triage.total} — see TRIAGE_EVAL.md)`
      : 'Triage agreement: not yet run',
  );
  if (row.errors.length > 0) {
    out.push('', '**Provider errors (not scored):**', '');
    for (const e of row.errors) out.push(`- ${e.role} / ${e.caseId}: ${e.error}`);
  }
  out.push('');
  return out;
}

export function renderModelEval(file: ModelEvalFile): string {
  const out: string[] = [
    '# Model evaluation',
    '',
    '<!-- Generated from packages/security/src/eval/results.generated.ts by packages/security/src/eval/cli.ts. Do not edit. -->',
    '',
    'How well each model does each analysis role on labelled fixtures (W19-05). For every role the',
    'specialist is run over cases with a planted defect and clean cases, and scored for:',
    '',
    '- **Precision** — of what it reported, how much was a planted defect. A model that cries wolf scores low.',
    '- **Recall** — of the planted defects, how many it reported. A model that misses things scores low.',
    '- **Not scored** — cases that hit a provider error. They are listed in full and the role is shown as',
    '  *incomplete*; a dropped connection is never published as a model that found nothing.',
    '- **Format failures** — cases where the model never produced the required JSON after one retry; scored',
    '  as having found nothing, and counted because it is a property of the model.',
    '',
    '> The fixtures are small (four cases per role, eight for performance; half with a planted defect, half clean), written for this',
    '> ticket by an AI assistant, and **their labels have not been reviewed by a person**. They are an',
    '> indicative floor, not an accuracy estimate. The OWASP Benchmark and Juliet slices in',
    '> `fixtures/benchmark` grade scanner detection and need a fetched corpus; they are **not** part of',
    '> these runs. Results depend on the provider: the temperature is fixed at 0.1, and a seed is sent only',
    '> when requested and may be ignored by the server.',
    '',
  ];
  if (file.rows.length === 0) {
    out.push(
      '**This has not been run yet.** No model has been measured, so every cell is "not yet run".',
      '',
    );
    return out.join('\n');
  }
  for (const row of file.rows) out.push(...section(row));
  return out.join('\n');
}
