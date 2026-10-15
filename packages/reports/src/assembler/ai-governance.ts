import {
  computeAiGovernance,
  governanceSentence,
  type AiGovernanceResult,
  type GovernanceMeasure,
} from '@repopulse/metrics';
import type { Database } from '@repopulse/shared';
import type { ReportSection } from '../types/index.js';

// The AI-code governance section (W18-20, REPORTS.md §1).
//
// SIGNALS, NOT GRADES (N-9). The section sets two cohorts side by side and
// says which way each measure leans, in words that carry no verdict. It names
// no person and ranks nothing: the cohorts are "AI-authored" and "human", and
// what an organisation concludes from a higher rework rate on AI changes is a
// conversation for the people who know the work.
//
// A SMALL SAMPLE IS SAID OUT LOUD. Each measure has a minimum per cohort
// (GOVERNANCE_MIN_SAMPLE); below it the row prints both numbers with "too small
// to compare" instead of a direction, and when nothing is comparable the
// summary leads with that sentence rather than with a table that invites one.

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const r2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

function cell(m: GovernanceMeasure, v: number | null): number | string | null {
  if (v === null) return null;
  return m.unit === 'ratio' ? pct(v) : r2(v);
}

/** The words a reader sees in the Comparison column — never better/worse. */
function comparisonCell(m: GovernanceMeasure): string {
  if (!m.comparable || m.direction === null) return m.note ?? 'not comparable';
  return m.direction === 'similar' ? 'similar' : `${m.direction} for AI-authored`;
}

/** Who is in neither cohort, said only when someone is. */
function excludedSentence(automation: number, unknown: number): string {
  const parts = [
    ...(automation > 0 ? [`${automation} automation commits (dependency bots and the like)`] : []),
    ...(unknown > 0 ? [`${unknown} commits ingested before authorship signals were recorded`] : []),
  ];
  return parts.length === 0 ? '' : `Not in either cohort: ${parts.join(' and ')}.`;
}

export function aiGovernanceSectionsFrom(g: AiGovernanceResult): ReportSection[] {
  const classified = g.counts.aiCommits + g.counts.humanCommits;
  const notClassified = g.counts.unknownCommits;
  if (classified === 0) {
    return [
      {
        kind: 'no_data',
        id: 'ai_governance',
        reason:
          notClassified > 0
            ? `No change in this window could be classified: ${notClassified} commits were ingested before authorship signals were recorded. Re-running the repository backfill records them.`
            : 'No non-merge commits in this window, so there is nothing to compare.',
      },
    ];
  }

  const lines: string[] = [
    `**AI-authored changes: ${pct(g.aiShareCommits)} of commits** (${g.counts.aiCommits} of ${classified})` +
      (g.aiSharePrs === null
        ? '.'
        : ` and **${pct(g.aiSharePrs)} of pull requests** (${g.counts.aiPrs} of ${g.counts.aiPrs + g.counts.humanPrs}).`),
  ];
  if (!g.anyComparable) {
    lines.push(
      '',
      'The sample is **too small to compare** AI-authored and human changes in this window. The numbers below are shown for completeness; none of them supports a conclusion yet.',
    );
  } else {
    // One paragraph per sentence: the report renderer has paragraphs and
    // inline emphasis, not lists, and a "- " would print literally.
    for (const m of g.measures.filter((x) => x.comparable)) lines.push('', governanceSentence(m));
  }
  lines.push(
    '',
    'These are **signals, not grades**: a higher figure is a reason to look, not a verdict on AI-assisted work or on anyone using it. Results are aggregated across the scope and never broken down by person.',
    '',
    `Classified from co-author trailers, agent bot accounts and agent branch prefixes (pattern set \`${g.patternsFingerprint}\`). ` +
      excludedSentence(g.counts.automationCommits, notClassified) +
      (g.findingsMeasured
        ? ` Findings are attributed to the pull request they were raised on, else to the last change to their file before they were first seen — an approximation${g.unattributedFindings > 0 ? `; ${g.unattributedFindings} repository-level findings could not be attributed` : ''}.`
        : ''),
  );

  return [
    { kind: 'summary', id: 'ai_governance', markdown: lines.join('\n') },
    {
      kind: 'table',
      id: 'ai_governance_measures',
      columns: ['Measure', 'AI-authored', 'Human', 'Sample (AI / human)', 'Comparison', 'Basis'],
      rows: g.measures.map((m) => [
        m.label,
        cell(m, m.ai),
        cell(m, m.human),
        `${m.aiSample} / ${m.humanSample} ${m.sampleUnit}`,
        comparisonCell(m),
        m.basis,
      ]),
    },
  ];
}

export async function aiGovernanceSections(
  db: Database,
  params: { workspaceId: number; repoIds: number[]; windowEnd: Date; windowDays: number },
): Promise<ReportSection[]> {
  return aiGovernanceSectionsFrom(await computeAiGovernance(db, params));
}
