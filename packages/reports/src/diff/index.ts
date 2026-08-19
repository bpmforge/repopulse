import type { ReportData, ReportSection } from '../types/index.js';

// Report diff (W5-09, R-A9).
//
// Pure data diffing, and it is only possible because of the W5-03 determinism
// pin: two reports of the same scope differ ONLY where the underlying numbers
// moved, never because they were generated at different moments. Without the
// pin this comparison would be noise.

export interface SectionDelta {
  sectionId: string;
  label: string;
  before: number | null;
  after: number | null;
  /** after − before, or null when either side is missing. */
  delta: number | null;
  /** True when the row exists on one side only — appeared or disappeared. */
  onlyOneSide: boolean;
}

export interface ReportDiff {
  comparable: boolean;
  reason?: string;
  deltas: SectionDelta[];
}

function tableRows(section: ReportSection): { label: string; value: number | null }[] {
  if (section.kind !== 'table') return [];
  return section.rows.map((row) => {
    const label = String(row[0] ?? '');
    // The first numeric cell is the row's value. Reports put the label first
    // and the measure next; scanning for the first number keeps this working
    // when a table gains a column.
    const value = row.slice(1).find((c) => typeof c === 'number');
    return { label, value: typeof value === 'number' ? value : null };
  });
}

function sectionKey(section: ReportSection, index: number): string {
  return section.kind === 'no_data' || section.kind === 'table' || section.kind === 'chart'
    ? (section.id ?? `${section.kind}-${index}`)
    : `${section.kind}-${index}`;
}

/**
 * Compares two reports of the same type and scope.
 *
 * Refuses rather than guesses when the two are not comparable: a "diff" between
 * a repo-health report and a DORA report would produce rows that look like
 * movement and mean nothing.
 */
export function diffReports(before: ReportData, after: ReportData): ReportDiff {
  if (before.params.type !== after.params.type) {
    return {
      comparable: false,
      reason: `Different report types (${before.params.type} vs ${after.params.type}) — there is nothing meaningful to compare.`,
      deltas: [],
    };
  }
  const sameScope =
    before.params.repoIds.length === after.params.repoIds.length &&
    before.params.repoIds.every((id) => after.params.repoIds.includes(id));
  if (!sameScope) {
    return {
      comparable: false,
      reason:
        'Different repository scopes — a change in the numbers would be a change in what was measured, not in the work.',
      deltas: [],
    };
  }
  if (before.params.windowDays !== after.params.windowDays) {
    return {
      comparable: false,
      reason: `Different windows (${before.params.windowDays}d vs ${after.params.windowDays}d) — a 7-day figure and a 90-day figure are not the same measurement.`,
      deltas: [],
    };
  }

  const beforeSections = new Map(before.sections.map((s, i) => [sectionKey(s, i), s]));
  const deltas: SectionDelta[] = [];

  after.sections.forEach((section, index) => {
    const key = sectionKey(section, index);
    const previous = beforeSections.get(key);
    const afterRows = tableRows(section);
    const beforeRows = new Map(previous ? tableRows(previous).map((r) => [r.label, r.value]) : []);

    for (const row of afterRows) {
      const had = beforeRows.has(row.label);
      const beforeValue = had ? (beforeRows.get(row.label) ?? null) : null;
      deltas.push({
        sectionId: key,
        label: row.label,
        before: beforeValue,
        after: row.value,
        // null rather than treating a missing side as zero: a metric that
        // appeared this month has not "increased from 0", and rendering that
        // as growth would invent a trend.
        delta: beforeValue !== null && row.value !== null ? row.value - beforeValue : null,
        onlyOneSide: !had,
      });
      beforeRows.delete(row.label);
    }

    // Rows that vanished are movement too — a hotspot dropping off the list is
    // exactly what someone reading a diff wants to see.
    for (const [label, value] of beforeRows) {
      deltas.push({
        sectionId: key,
        label,
        before: value,
        after: null,
        delta: null,
        onlyOneSide: true,
      });
    }
  });

  return { comparable: true, deltas };
}
